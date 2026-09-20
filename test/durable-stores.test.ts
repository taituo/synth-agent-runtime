import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionBroker,
  InMemoryContinuationStore,
  InMemoryLeaseStore,
  InMemoryMailboxStore,
  InMemoryWorldStore,
  JsonFileRuntimeStateStore,
  JsonFileWorldStore,
  LocalMemoryDurability,
  LocalRuntimeStateStore,
  type Artifact,
  type Effect,
  type Executor,
  type TaskSpec,
} from "../src/index.js";

test("lease fencing token advances and stale owner cannot renew", async () => {
  let now = 1000;
  const leases = new InMemoryLeaseStore(() => now);
  const first = await leases.acquireLease("agent:a", "worker-1", 100, now);
  assert.equal(first.acquired, true);
  assert.equal(first.lease.fencingToken, 1);
  const blocked = await leases.acquireLease("agent:a", "worker-2", 100, now + 50);
  assert.equal(blocked.acquired, false);
  now = 1200;
  const second = await leases.acquireLease("agent:a", "worker-2", 100, now);
  assert.equal(second.acquired, true);
  assert.equal(second.lease.fencingToken, 2);
  assert.equal(await leases.renewLease("agent:a", "worker-1", 1, 100, now), undefined);
  assert.equal(await leases.releaseLease("agent:a", "worker-1", 1), false);
});

test("stale command generation cannot overwrite committed higher fence", async () => {
  const state = new LocalRuntimeStateStore();
  await state.putCommand({ id: "c", status: "committed", startedAt: 1, updatedAt: 3, fencingToken: 5, result: "winner" });
  await state.putCommand({ id: "c", status: "started", startedAt: 1, updatedAt: 4, fencingToken: 4, error: "stale" });
  const record = await state.getCommand("c");
  assert.equal(record?.status, "committed");
  assert.equal(record?.result, "winner");
});

test("mailbox acknowledgement cannot skip beyond messages that exist", async () => {
  const mailbox = new InMemoryMailboxStore();
  const agentId = "a" as any;
  await mailbox.appendMailbox(agentId, { id: "x", role: "human", text: "one", createdAt: 1 });
  const cursor = await mailbox.ackMailbox(agentId, "engine", 999);
  assert.equal(cursor.ackSeq, 1);
});

test("world compare-and-swap rejects stale concurrent project mutation", async () => {
  const world = new InMemoryWorldStore();
  const project = await world.createProject({ name: "p", objective: "ship" });
  const a = (await world.getProject(project.id))!;
  const b = (await world.getProject(project.id))!;
  a.objective = "A";
  const first = await world.compareAndSwapProject(a, a.revision);
  assert.equal(first.swapped, true);
  b.objective = "B";
  const stale = await world.compareAndSwapProject(b, b.revision);
  assert.equal(stale.swapped, false);
  assert.equal(stale.project.objective, "A");
  assert.equal(stale.project.revision, 1);
  await assert.rejects(() => world.putProject({ ...b, objective: "force stale" }), /WORLD_PUT_REQUIRES_NEWER_REVISION/);
});

test("world compare-and-swap rejects stale concurrent task and artifact mutation", async () => {
  const world = new InMemoryWorldStore();
  const task: TaskSpec = { id: "task-1" as any, title: "t", objective: "o", status: "pending" };
  await world.putTask(task);
  const a = (await world.getTask(task.id))!;
  const b = (await world.getTask(task.id))!;
  const first = await world.compareAndSwapTask!({ ...a, status: "running" }, a.revision ?? 0);
  assert.equal(first.swapped, true);
  assert.equal(first.task.revision, 1);
  const stale = await world.compareAndSwapTask!({ ...b, status: "completed" }, b.revision ?? 0);
  assert.equal(stale.swapped, false);
  assert.equal(stale.task.status, "running");
  assert.equal(stale.task.revision, 1);

  // An Artifact carries a REFERENCE, never inline bytes.
  const ref = (v: number) => ({ digest: `sha256:${String(v).padStart(64, "0")}`, size: v, mediaType: "text/plain", mechanism: "test" });
  const artifact: Artifact = { id: "art-1" as any, type: "report", createdAt: 1, ref: ref(1) };
  await world.putArtifact(artifact);
  const c = (await world.getArtifact(artifact.id))!;
  const d = (await world.getArtifact(artifact.id))!;
  const artifactFirst = await world.compareAndSwapArtifact!({ ...c, ref: ref(2) }, c.revision ?? 0);
  assert.equal(artifactFirst.swapped, true);
  assert.equal(artifactFirst.artifact.revision, 1);
  const artifactStale = await world.compareAndSwapArtifact!({ ...d, ref: ref(3) }, d.revision ?? 0);
  assert.equal(artifactStale.swapped, false);
  assert.equal(artifactStale.artifact.ref.size, 2);
  assert.equal(artifactStale.artifact.revision, 1);
});

test("world store builds a compact project projection", async () => {
  const world = new InMemoryWorldStore();
  const project = await world.createProject({ name: "p", objective: "ship", constraints: ["no host writes"] });
  const task: TaskSpec = { id: "task-1" as any, title: "t", objective: "do it", status: "pending" };
  await world.attachTask(project.id, task);
  await world.addDecision(project.id, { title: "RAM first", rationale: "cheap forks", status: "accepted" });
  const projection = await world.projection(project.id);
  assert.ok(projection?.contextText.includes("no host writes"));
  assert.ok(projection?.contextText.includes("RAM first"));
  assert.ok(projection?.contextText.includes("do it"));
});

test("json file world persists project state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synth-world-"));
  try {
    const file = join(dir, "world.json");
    const world = await JsonFileWorldStore.open(file);
    const project = await world.createProject({ name: "durable", objective: "persist" });
    await world.addDecision(project.id, { title: "D", rationale: "R", status: "accepted" });
    const reopened = await JsonFileWorldStore.open(file);
    const projection = await reopened.projection(project.id);
    assert.equal(projection?.project.name, "durable");
    assert.ok(projection?.contextText.includes("D"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("effect receipts are monotonic: a resolved receipt cannot be regressed", async () => {
  const state = new LocalRuntimeStateStore();
  await state.putEffect({ id: "e-regress", kind: "workflow.run", status: "started", startedAt: 1, updatedAt: 1 });
  await state.putEffect({ id: "e-regress", kind: "workflow.run", status: "committed", startedAt: 1, updatedAt: 2, result: { ok: true, output: "done" } });
  await state.putEffect({ id: "e-regress", kind: "workflow.run", status: "started", startedAt: 1, updatedAt: 3, error: "pending:x" });
  await state.putEffect({ id: "e-regress", kind: "workflow.run", status: "failed", startedAt: 1, updatedAt: 4, error: "boom" });
  const after = await state.getEffect("e-regress");
  assert.equal(after?.status, "committed");
  assert.deepEqual(after?.result, { ok: true, output: "done" });

  await state.putEffect({ id: "e-failed", kind: "workflow.run", status: "failed", startedAt: 1, updatedAt: 1, error: "boom" });
  await state.putEffect({ id: "e-failed", kind: "workflow.run", status: "started", startedAt: 1, updatedAt: 2, error: "pending:x" });
  assert.equal((await state.getEffect("e-failed"))?.status, "failed");
});

test("event retention watermark is the slowest registered consumer", async () => {
  const durability = new LocalMemoryDurability();
  for (let i = 0; i < 5; i++) {
    await durability.appendEvent({ type: "agent.created", agent: { id: `a${i}` } as any, at: i } as any);
  }
  assert.equal(await durability.safeEventWatermark!(), 0, "no consumers must fail closed");
  await durability.ackEvent!("c1", 3);
  await durability.ackEvent!("c2", 5);
  assert.equal(await durability.safeEventWatermark!(), 3);

  // Acks are monotonic and clamped to the current max sequence.
  assert.equal((await durability.ackEvent!("c1", 1)).ackSeq, 3);
  assert.equal((await durability.ackEvent!("c1", 99)).ackSeq, 5);
  assert.equal(await durability.safeEventWatermark!(), 5);

  // A lagging consumer holds retention back; forgetting it raises the watermark.
  await durability.ackEvent!("c3", 1);
  assert.equal(await durability.safeEventWatermark!(), 1);
  assert.equal(await durability.forgetEventConsumer!("c3"), true);
  assert.equal(await durability.safeEventWatermark!(), 5);

  // Safe pruning removes exactly the acked prefix.
  assert.equal(await durability.pruneEventsSafe!(), 5);
  assert.deepEqual((await durability.readEvents!()).map((e) => e.seq), []);
});

test("pruneEventsSafe never removes events with no registered consumer", async () => {
  const durability = new LocalMemoryDurability();
  await durability.appendEvent({ type: "agent.created", agent: { id: "a" } as any, at: 1 } as any);
  assert.equal(await durability.pruneEventsSafe!(), 0);
  assert.equal((await durability.readEvents!()).length, 1);
});

test("durability event cursors resume and retention prunes old events", async () => {
  const durability = new LocalMemoryDurability();
  await durability.appendEvent({ type: "agent.output", agentId: "a" as any, text: "1", at: 1 });
  await durability.appendEvent({ type: "agent.output", agentId: "a" as any, text: "2", at: 2 });
  await durability.appendEvent({ type: "agent.output", agentId: "a" as any, text: "3", at: 3 });
  const tail = await durability.readEvents!({ afterSeq: 1, limit: 10 });
  assert.deepEqual(tail.map((e) => e.seq), [2, 3]);
  assert.equal(await durability.pruneEvents!(2), 2);
  assert.deepEqual((await durability.readEvents!()).map((e) => e.seq), [3]);
});

test("continuation store isolates tenant continuation ids", async () => {
  const store = new InMemoryContinuationStore<{ value: string }>();
  await store.putContinuation({ id: "r1", tenantId: "t1", value: { value: "secret" }, createdAt: Date.now(), expiresAt: Date.now() + 10000 });
  assert.equal((await store.getContinuation("r1", "t1"))?.value.value, "secret");
  assert.equal(await store.getContinuation("r1", "t2"), undefined);
  assert.equal(await store.getContinuation("r1"), undefined);
});

test("execution broker uses effect id as durable idempotency key", async () => {
  const state = new LocalRuntimeStateStore();
  let calls = 0;
  const executor: Executor = {
    id: "x",
    fidelity: 1,
    canExecute: () => true,
    async execute() { calls++; return { ok: true, output: { calls } }; },
  };
  const broker = new ExecutionBroker([executor], state);
  const effect: Effect = { id: "stable-effect", kind: "process.exec", command: "true" };
  const context = { agentId: "a" as any, workspaceId: "w" as any };
  const first = await broker.execute(effect, context);
  const second = await broker.execute(effect, context);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
});

test("json runtime state survives process-style reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synth-runtime-"));
  try {
    const path = join(dir, "runtime.json");
    const first = new JsonFileRuntimeStateStore(path);
    await first.putCommand({ id: "c", status: "committed", startedAt: 1, updatedAt: 2, result: { ok: true } });
    const second = new JsonFileRuntimeStateStore(path);
    assert.deepEqual((await second.getCommand("c"))?.result, { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
