/**
 * Follow-up 1 live proof: an activity that returns `state: "waiting"` must NOT
 * make the workflow spin.
 *
 * The assertion is a BOUND ON ACTIVITY CALLS within a fixed window — a status
 * assertion alone would pass on the spinning code, because the status still
 * flickers to "waiting" between iterations.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx waiting-spin-live.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { runTemporalWorker } from "./src/worker.js";
import type { DurableAgentState } from "./src/contracts.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-waiting-spin-${Date.now()}`;
const FAST_PARK = { initialMs: 400, maxMs: 1_600 };
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 4_000);
const MAX_CALLS = Number(process.env.MAX_CALLS ?? 6);

let calls = 0;
const activities = {
  async runTurn() {
    calls++;
    // The activity defers the turn without consuming the mailbox.
    return { result: "deferred", state: "waiting" as const };
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

await sleep(2_500);
const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });

const agentId = `agt_waiting_spin_${Date.now()}`;
const handle = await client.workflow.start(durableAgentWorkflow, {
  taskQueue,
  workflowId: `agent/${agentId}`,
  args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now(), parkBackoff: FAST_PARK } as DurableAgentState],
});
const callsBefore = calls;
await handle.signal(sendMessage, { id: "w1", role: "human", text: "deferred", createdAt: Date.now(), kind: "incident" });
await sleep(WINDOW_MS);
const state = await handle.query(getAgentState).catch(() => undefined);
const callsInWindow = calls - callsBefore;
await handle.signal(cancelAgent).catch(() => undefined);
await handle.result().catch(() => undefined);

const ok = callsInWindow <= MAX_CALLS && state?.status === "waiting" && state?.mailbox.length === 1;
console.log(
  JSON.stringify(
    {
      address,
      windowMs: WINDOW_MS,
      maxCallsAllowed: MAX_CALLS,
      callsInWindow,
      callsPerSecond: Number((callsInWindow / (WINDOW_MS / 1000)).toFixed(1)),
      finalStatus: state?.status ?? "unknown",
      mailboxLength: state?.mailbox.length ?? null,
      ok,
    },
    null,
    2,
  ),
);
await connection.close();
process.exit(ok ? 0 : 1);
