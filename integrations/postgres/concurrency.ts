import { randomUUID } from "node:crypto";
import { openPostgresPersistence } from "./node-pg.js";

const url = process.env.SYNTH_POSTGRES_URL;
if (!url) {
  console.error(JSON.stringify({ skipped: true, reason: "SYNTH_POSTGRES_URL not set; live Postgres required" }));
  process.exit(2);
}
const workers = Math.max(2, Number(process.env.SYNTH_POSTGRES_WORKERS ?? 16));
const prefix = `live-${randomUUID()}`;

const opened = await Promise.all(Array.from({ length: workers }, () => openPostgresPersistence({ connectionString: url })));
try {
  const commandId = `${prefix}-command`;
  const command = { id: commandId, status: "started" as const, startedAt: Date.now(), updatedAt: Date.now() };
  const commandClaims = await Promise.all(opened.map(({ persistence }) => persistence.claimCommand(command)));
  const commandWinners = commandClaims.filter((claim) => claim.claimed).length;
  if (commandWinners !== 1) throw new Error(`Expected one command claim winner, got ${commandWinners}`);

  const effectId = `${prefix}-effect`;
  const effect = { id: effectId, status: "started" as const, kind: "process.exec", startedAt: Date.now(), updatedAt: Date.now() };
  const effectClaims = await Promise.all(opened.map(({ persistence }) => persistence.claimEffect(effect)));
  const effectWinners = effectClaims.filter((claim) => claim.claimed).length;
  if (effectWinners !== 1) throw new Error(`Expected one effect claim winner, got ${effectWinners}`);

  const leaseId = `${prefix}-agent`;
  const leaseClaims = await Promise.all(opened.map(({ distributed }, index) => distributed.acquireLease(leaseId, `worker-${index}`, 30_000)));
  const leaseWinners = leaseClaims.filter((claim) => claim.acquired).length;
  if (leaseWinners !== 1) throw new Error(`Expected one lease winner, got ${leaseWinners}`);
  const winningLease = leaseClaims.find((claim) => claim.acquired)!.lease;


  // Lease time must be decided by PostgreSQL, not by a skewed worker clock.
  const clockLeaseId = `${prefix}-clock-lease`;
  const clockFirst = await opened[0]!.distributed.acquireLease(clockLeaseId, "clock-a", 30_000, -9_000_000_000_000_000);
  if (!clockFirst.acquired) throw new Error("Expected first DB-clock lease claim to win");
  const clockSecond = await opened[1]!.distributed.acquireLease(clockLeaseId, "clock-b", 30_000, 9_000_000_000_000_000);
  if (clockSecond.acquired) throw new Error("Worker-local future clock incorrectly stole a DB-clock lease");

  // Hard agent fencing: once generation 2 wins, generation 1 can never publish.
  const agentId = `${prefix}-fenced-agent` as any;
  const agentResource = `agent:${agentId}`;
  const bootstrap = {
    id: agentId, definitionId: "live", workspaceId: `${prefix}-workspace` as any, state: "idle" as const,
    createdAt: Date.now(), updatedAt: Date.now(), mailbox: [], metadata: {},
  };
  await opened[0]!.persistence.putAgent(bootstrap);
  const ownerA = await opened[0]!.distributed.acquireLease(agentResource, "agent-worker-a", 30_000);
  if (!ownerA.acquired) throw new Error("Expected agent worker A to acquire lease");
  const aFence = { resourceId: agentResource, ownerId: ownerA.lease.ownerId, fencingToken: ownerA.lease.fencingToken };
  if (!(await opened[0]!.persistence.putAgentFenced({ ...bootstrap, state: "thinking", updatedAt: Date.now() }, aFence))) {
    throw new Error("Expected generation A fenced write to succeed");
  }
  await opened[0]!.distributed.releaseLease(agentResource, ownerA.lease.ownerId, ownerA.lease.fencingToken);
  const ownerB = await opened[1]!.distributed.acquireLease(agentResource, "agent-worker-b", 30_000);
  if (!ownerB.acquired) throw new Error("Expected agent worker B to acquire next generation");
  const bFence = { resourceId: agentResource, ownerId: ownerB.lease.ownerId, fencingToken: ownerB.lease.fencingToken };
  if (!(await opened[1]!.persistence.putAgentFenced({ ...bootstrap, state: "completed", updatedAt: Date.now() }, bFence))) {
    throw new Error("Expected generation B fenced write to succeed");
  }
  if (await opened[0]!.persistence.putAgentFenced({ ...bootstrap, state: "failed", updatedAt: Date.now() }, aFence)) {
    throw new Error("Stale generation A unexpectedly overwrote generation B");
  }
  const fencedAgent = await opened[0]!.persistence.getAgent(agentId);
  if (fencedAgent?.state !== "completed") throw new Error(`Expected completed fenced winner, got ${fencedAgent?.state}`);
  let unfencedRejected = false;
  try { await opened[0]!.persistence.putAgent({ ...bootstrap, state: "failed", updatedAt: Date.now() }); }
  catch (error) { unfencedRejected = String(error).includes("AGENT_FENCE_REQUIRED"); }
  if (!unfencedRejected) throw new Error("Expected unfenced write to a fenced agent to be rejected");

  const projectId = `${prefix}-project` as any;
  const project = { id: projectId, revision: 0, name: "live", objective: "base", createdAt: Date.now(), updatedAt: Date.now(), constraints: [], decisions: [], taskIds: [], artifactIds: [], metadata: {} };
  await opened[0]!.persistence.putProject(project);
  const casResults = await Promise.all(opened.slice(0, 2).map(({ persistence }, index) => persistence.compareAndSwapProject({ ...project, objective: `writer-${index}` }, 0)));
  const casWinners = casResults.filter((result) => result.swapped).length;
  if (casWinners !== 1) throw new Error(`Expected one project CAS winner, got ${casWinners}`);

  console.log(JSON.stringify({
    ok: true, workers, commandWinners, effectWinners, leaseWinners, fencingToken: winningLease.fencingToken,
    dbClockSkewBlocked: !clockSecond.acquired, hardAgentFencing: fencedAgent?.state === "completed", casWinners, prefix,
  }));
} finally {
  const pool = opened[0]?.pool;
  if (pool) {
    await pool.query("DELETE FROM synth_commands WHERE id=$1", [`${prefix}-command`]).catch(() => {});
    await pool.query("DELETE FROM synth_effects WHERE id=$1", [`${prefix}-effect`]).catch(() => {});
    await pool.query("DELETE FROM synth_leases WHERE resource_id IN ($1,$2,$3)", [`${prefix}-agent`, `${prefix}-clock-lease`, `agent:${prefix}-fenced-agent`]).catch(() => {});
    await pool.query("DELETE FROM synth_agents WHERE id=$1", [`${prefix}-fenced-agent`]).catch(() => {});
    await pool.query("DELETE FROM synth_projects WHERE id=$1", [`${prefix}-project`]).catch(() => {});
  }
  await Promise.all(opened.map((entry) => entry.close()));
}
