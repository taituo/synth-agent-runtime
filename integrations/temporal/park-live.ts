/**
 * Live proof of how a durable agent behaves when its turn keeps failing.
 *
 * A durable agent must survive a provider outage longer than one activity
 * retry cycle: when retries are exhausted on a TRANSIENT failure the agent
 * should park (status "waiting", mailbox intact, cause visible) and try again
 * later, not die. A PERMANENT failure (e.g. bad credentials) is different and
 * should end the agent immediately. Cancelling a parked agent must be prompt.
 *
 * Runs three scenarios against a real Temporal dev server, with a controllable
 * activity in place of a model:
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx park-live.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ApplicationFailure } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { runTemporalWorker } from "./src/worker.js";
import type { DurableAgentState, RunTurnInput, RunTurnResult } from "./src/contracts.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-park-${Date.now()}`;

/** Per-agent script: how many calls fail (retryably) before one succeeds, or a permanent failure. */
const behaviour = new Map<string, { failCalls: number; permanent?: boolean; calls: number }>();

const activities = {
  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const plan = behaviour.get(input.agentId)!;
    plan.calls++;
    if (plan.permanent) throw ApplicationFailure.nonRetryable("invalid credentials", "AuthError");
    if (plan.calls <= plan.failCalls) throw new Error(`provider unavailable (call ${plan.calls})`);
    return { result: `done after ${plan.calls} calls`, state: "idle" };
  },
};

void runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./src/workflows.ts", import.meta.url)),
  workflowInterceptorModules: [fileURLToPath(new URL("./src/workflow-interceptors.ts", import.meta.url))],
  activities,
  taskQueue,
  address,
  namespace,
}).catch((error) => {
  console.error("worker failed", error);
  process.exit(1);
});

await sleep(2500);
const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });

// Short park backoff so the run stays fast; the workflow's defaults are minutes.
const FAST_PARK = { initialMs: 400, maxMs: 1600 };

async function start(agentId: string) {
  const handle = await client.workflow.start(durableAgentWorkflow, {
    taskQueue,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now(), parkBackoff: FAST_PARK } as DurableAgentState],
  });
  await handle.signal(sendMessage, { id: `${agentId}-m1`, role: "human", text: "hello", createdAt: Date.now(), kind: "incident" });
  return handle;
}

async function waitForStatus(handle: Awaited<ReturnType<typeof start>>, status: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await handle.query(getAgentState).catch(() => undefined);
    if (state?.status === status) return state;
    await sleep(100);
  }
  return undefined;
}

const stamp = Date.now();
const report: Record<string, unknown> = { address };

// A. Transient outage that outlasts one retry cycle (3 attempts): calls 1-4 fail.
{
  const agentId = `agt_park_transient_${stamp}`;
  behaviour.set(agentId, { failCalls: 4, calls: 0 });
  const handle = await start(agentId);
  const parked = await waitForStatus(handle, "waiting", 20000);
  const final = (await waitForStatus(handle, "idle", 30000)) ?? (await handle.query(getAgentState).catch(() => undefined));
  const plan = behaviour.get(agentId)!;
  report.transient = {
    parkedAtSomePoint: parked !== undefined,
    mailboxKeptWhileParked: parked?.mailbox.length === 1,
    causeVisibleWhileParked: /provider unavailable/.test(parked?.lastError ?? ""),
    finalStatus: final?.status,
    finalMailboxLength: final?.mailbox.length,
    finalLastError: final?.lastError ?? null,
    finalResult: final?.lastResult,
    activityCalls: plan.calls,
    ok:
      parked !== undefined &&
      parked.mailbox.length === 1 &&
      /provider unavailable/.test(parked.lastError ?? "") &&
      final?.status === "idle" &&
      final.mailbox.length === 0 &&
      (final.lastError ?? null) === null &&
      typeof final.lastResult === "string",
  };
  await handle.signal(cancelAgent).catch(() => undefined);
}

// B. Permanent failure: ends immediately, one attempt.
{
  const agentId = `agt_park_permanent_${stamp}`;
  behaviour.set(agentId, { failCalls: 0, permanent: true, calls: 0 });
  const handle = await start(agentId);
  const final = await waitForStatus(handle, "failed", 15000);
  const plan = behaviour.get(agentId)!;
  report.permanent = {
    finalStatus: final?.status,
    lastError: final?.lastError,
    activityCalls: plan.calls,
    ok: final?.status === "failed" && plan.calls === 1 && /invalid credentials/.test(final.lastError ?? ""),
  };
}

// C. Cancelling a parked agent is prompt.
{
  const agentId = `agt_park_cancel_${stamp}`;
  behaviour.set(agentId, { failCalls: 1_000_000, calls: 0 });
  const handle = await start(agentId);
  const parked = await waitForStatus(handle, "waiting", 20000);
  const cancelStartedAt = Date.now();
  await handle.signal(cancelAgent).catch(() => undefined);
  const ended = await Promise.race([handle.result(), sleep(8000).then(() => undefined)]);
  report.cancelWhileParked = {
    wasParked: parked !== undefined,
    finalStatus: ended?.status,
    tookMs: Date.now() - cancelStartedAt,
    ok: parked !== undefined && ended?.status === "cancelled" && Date.now() - cancelStartedAt < 4000,
  };
}

const ok = ["transient", "permanent", "cancelWhileParked"].every((key) => (report[key] as { ok: boolean }).ok);
console.log(JSON.stringify({ ...report, ok }, null, 2));
await connection.close();
process.exit(ok ? 0 : 1);
