/**
 * Fault matrix cell: a NON-RETRYABLE provider failure (HTTP 4xx/auth).
 *
 * The companion of `retry-hint-live.ts`: there a transient 429 parks and
 * recovers with no human; here the activity throws a non-retryable
 * `ApplicationFailure` (what `createGatewayRunTurn` maps HTTP 400/401/403 to).
 * The durable workflow must NOT park forever and must NOT retry the activity:
 * it goes to `failed`, which is the "a human is needed" outcome.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx fault-gateway-fatal.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ApplicationFailure } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { runTemporalWorker } from "./src/worker.js";
import type { DurableAgentState } from "./src/contracts.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-fatal-${Date.now()}`;
const BLIND_PARK = { initialMs: 300, maxMs: 600 };

let activityCalls = 0;
const activities = {
  async runTurn(): Promise<{ result: string; state: "idle" }> {
    activityCalls += 1;
    throw ApplicationFailure.nonRetryable("gateway returned HTTP 400: bad request", "GatewayHTTP400");
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
const agentId = `agt_fatal_${Date.now()}`;
const handle = await client.workflow.start(durableAgentWorkflow, {
  taskQueue,
  workflowId: `agent/${agentId}`,
  args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now(), parkBackoff: BLIND_PARK } as DurableAgentState],
});
await handle.signal(sendMessage, { id: "f1", role: "human", text: "use bad credentials", createdAt: Date.now(), kind: "incident" });

let state: DurableAgentState | undefined;
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  state = await handle.query(getAgentState).catch(() => undefined);
  if (state?.status === "failed" || state?.status === "cancelled") break;
  await sleep(100);
}

const status = state?.status ?? "unknown";
const lastError = state?.lastError ?? null;
const parked = status === "waiting";
const ok = status === "failed" && activityCalls === 1 && !parked && /HTTP 400/.test(String(lastError));
await handle.signal(cancelAgent).catch(() => {});
console.log(JSON.stringify({
  address,
  status,
  lastError,
  activityCalls,
  parked,
  questions: {
    retried: activityCalls > 1,
    dataLost: null,
    humanNeeded: true,
    sideEffectTwice: false,
  },
  ok,
}, null, 2));
await connection.close();
process.exit(ok ? 0 : 1);
