/**
 * Item 2 live proof: a 429 whose reset is far beyond the clamp (2 hours) is
 * surfaced as quota exhaustion, not ordinary throttling.
 *
 * The activity 429s for its first three calls carrying `retryAfterMs` of two
 * hours, then succeeds. The workflow must not wait two hours (the clamp falls
 * back to the blind backoff) and must make the condition legible in both
 * `lastError` (`QUOTA_EXHAUSTED:...`) and the park log (`reason:
 * "quota-exhausted"`).
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx quota-exhausted-live.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ApplicationFailure } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { DefaultLogger, Runtime, type LogEntry } from "@temporalio/worker";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { runTemporalWorker } from "./src/worker.js";
import type { DurableAgentState } from "./src/contracts.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-quota-${Date.now()}`;
const QUOTA_HINT_MS = 2 * 60 * 60 * 1000; // two hours: beyond the one-hour clamp
const BLIND_PARK = { initialMs: 300, maxMs: 600 };

const logs: LogEntry[] = [];
Runtime.install({ logger: new DefaultLogger("INFO", (entry) => { logs.push(entry); }) });

const callsByAgent = new Map<string, number>();
const activities = {
  async runTurn(input: { agentId: string }) {
    const call = (callsByAgent.get(input.agentId) ?? 0) + 1;
    callsByAgent.set(input.agentId, call);
    if (call <= 3) {
      throw ApplicationFailure.create({
        message: "gateway returned HTTP 429: rate limited",
        type: "RateLimited",
        details: [{ retryAfterMs: QUOTA_HINT_MS }],
      });
    }
    return { result: `ok:${call}`, state: "idle" as const };
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

const agentId = `agt_quota_${Date.now()}`;
const handle = await client.workflow.start(durableAgentWorkflow, {
  taskQueue,
  workflowId: `agent/${agentId}`,
  args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now(), parkBackoff: BLIND_PARK } as DurableAgentState],
});
const startedAt = Date.now();
await handle.signal(sendMessage, { id: "q1", role: "human", text: "quota exhausted", createdAt: Date.now(), kind: "incident" });

let parkedLastError: string | undefined;
let state: DurableAgentState | undefined;
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  state = await handle.query(getAgentState).catch(() => undefined);
  if (state?.status === "waiting" && state.lastError?.includes("QUOTA_EXHAUSTED") && parkedLastError === undefined) {
    parkedLastError = state.lastError;
  }
  if (state?.status === "idle" && state.mailbox.length === 0) break;
  await sleep(20);
}
await handle.signal(cancelAgent).catch(() => undefined);
await handle.result().catch(() => undefined);

const quotaLog = logs.find((entry) => entry.message === "synth.workflow.parked" && entry.meta?.reason === "quota-exhausted");
const waitedMs = Date.now() - startedAt;
const ok =
  parkedLastError !== undefined &&
  quotaLog !== undefined &&
  state?.status === "idle" &&
  (state?.lastError ?? null) === null &&
  // It must NOT have waited the two-hour hint.
  waitedMs < 60_000;
console.log(
  JSON.stringify(
    {
      address,
      quotaHintMs: QUOTA_HINT_MS,
      parkedLastError: parkedLastError ?? null,
      quotaExhaustedLogSeen: quotaLog !== undefined,
      quotaLogMeta: quotaLog?.meta ?? null,
      finalStatus: state?.status ?? "unknown",
      finalLastError: state?.lastError ?? null,
      waitedMs,
      ok,
    },
    null,
    2,
  ),
);
await connection.close();
process.exit(ok ? 0 : 1);
