/**
 * Track 6 live proof: signals during every phase, and query correctness under
 * load, against a real Temporal dev server.
 *
 *   A. signal during an in-flight turn  -> queued, processed next turn, not lost
 *   B. signal while parked (waiting)     -> does NOT cut the backoff short; queued
 *                                            and processed after recovery
 *   C. cancel during an in-flight turn   -> ends promptly as `cancelled`
 *   D. 40 concurrent queries under load  -> every query returns a valid state
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx phase-signals-driver.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Context as ActivityContext } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { runTemporalWorker } from "./src/worker.js";
import type { DurableAgentState } from "./src/contracts.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-phase-${Date.now()}`;
const SLOW_MS = Number(process.env.SLOW_MS ?? 1500);
const FAST_PARK = { initialMs: 600, maxMs: 2400 };

interface Plan {
  mode: "ok" | "slow" | "fail";
  calls: number;
  batches: string[][];
}
const behaviour = new Map<string, Plan>();

const activities = {
  async runTurn(input: { agentId: string; messages: Array<{ id: string }> }) {
    const plan = behaviour.get(input.agentId)!;
    plan.calls++;
    plan.batches.push(input.messages.map((message) => message.id));
    if (plan.mode === "fail") throw new Error("provider down (transient)");
    if (plan.mode === "slow") await sleep(SLOW_MS);
    ActivityContext.current().heartbeat();
    return { result: `ok:${input.messages.length}`, state: "idle" as const };
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

async function start(agentId: string, mode: Plan["mode"]) {
  behaviour.set(agentId, { mode, calls: 0, batches: [] });
  const handle = await client.workflow.start(durableAgentWorkflow, {
    taskQueue,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now(), parkBackoff: FAST_PARK } as DurableAgentState],
  });
  return handle;
}

async function signal(handle: Awaited<ReturnType<typeof start>>, id: string, text = "event") {
  await handle.signal(sendMessage, { id, role: "human", text, createdAt: Date.now(), kind: "incident" });
}

async function waitFor(handle: Awaited<ReturnType<typeof start>>, predicate: (state: DurableAgentState) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: DurableAgentState | undefined;
  while (Date.now() < deadline) {
    last = await handle.query(getAgentState).catch(() => undefined);
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  return last;
}

const report: Record<string, unknown> = { address };

// A. Signal during an in-flight turn.
{
  const id = `agt_phase_inflight_${Date.now()}`;
  const handle = await start(id, "slow");
  await signal(handle, "a1");
  await sleep(300); // turn is in flight
  await signal(handle, "a2");
  const state = await waitFor(handle, (s) => s.status === "idle" && s.mailbox.length === 0, 15000);
  const plan = behaviour.get(id)!;
  const flat = plan.batches.flat();
  report.signalDuringTurn = {
    finalStatus: state?.status,
    mailboxLength: state?.mailbox.length,
    batches: plan.batches,
    bothProcessedInOrder: flat.join(",") === "a1,a2",
    ok: state?.status === "idle" && state.mailbox.length === 0 && flat.join(",") === "a1,a2",
  };
  await handle.signal(cancelAgent).catch(() => undefined);
}

// B. Signal while parked.
{
  const id = `agt_phase_parked_${Date.now()}`;
  const handle = await start(id, "fail");
  await signal(handle, "b1");
  const parked = await waitFor(handle, (s) => s.status === "waiting", 15000);
  const parkedAt = Date.now();
  await signal(handle, "b2");
  await sleep(150);
  const stillParked = await handle.query(getAgentState).catch(() => undefined);
  behaviour.get(id)!.mode = "ok";
  const recovered = await waitFor(handle, (s) => s.status === "idle" && s.mailbox.length === 0, 20000);
  const plan = behaviour.get(id)!;
  const flat = plan.batches.flat();
  report.signalWhileParked = {
    parked: parked?.status,
    mailboxWhileParked: stillParked?.mailbox.length,
    stayedParkedAfterSignal: stillParked?.status === "waiting",
    recoveredStatus: recovered?.status,
    recoveredLastError: recovered?.lastError ?? null,
    bothProcessedInOrder: flat.join(",") === "b1,b1,b2" || flat.join(",") === "b1,b2",
    batches: plan.batches,
    ok:
      parked?.status === "waiting" &&
      stillParked?.status === "waiting" &&
      stillParked.mailbox.length === 2 &&
      recovered?.status === "idle" &&
      (recovered.lastError ?? null) === null &&
      flat.includes("b2"),
    parkedMs: Date.now() - parkedAt,
  };
  await handle.signal(cancelAgent).catch(() => undefined);
}

// C. Cancel during an in-flight turn.
{
  const id = `agt_phase_cancel_${Date.now()}`;
  const handle = await start(id, "slow");
  await signal(handle, "c1");
  await sleep(300);
  const cancelAt = Date.now();
  await handle.signal(cancelAgent);
  const ended = await Promise.race([handle.result(), sleep(10000).then(() => undefined)]);
  report.cancelDuringTurn = {
    finalStatus: ended?.status,
    tookMs: Date.now() - cancelAt,
    ok: ended?.status === "cancelled" && Date.now() - cancelAt < 8000,
  };
}

// D. Query correctness under load.
{
  const id = `agt_phase_query_${Date.now()}`;
  const handle = await start(id, "slow");
  await signal(handle, "d1");
  await sleep(200);
  const queries = await Promise.all(
    Array.from({ length: 40 }, () => handle.query(getAgentState).then(
      (state) => ({ ok: state.agentId === id && Array.isArray(state.mailbox) && typeof state.status === "string" }),
      (error) => ({ ok: false, error: String(error) }),
    )),
  );
  report.queryUnderLoad = {
    count: queries.length,
    allValid: queries.every((entry) => entry.ok),
    ok: queries.every((entry) => entry.ok),
  };
  await handle.signal(cancelAgent).catch(() => undefined);
  await handle.result().catch(() => undefined);
}

const ok = ["signalDuringTurn", "signalWhileParked", "cancelDuringTurn", "queryUnderLoad"].every(
  (key) => (report[key] as { ok: boolean }).ok,
);
console.log(JSON.stringify({ ...report, ok }, null, 2));
await connection.close();
process.exit(ok ? 0 : 1);
