/**
 * Item 1 live proof: the durable workflow honours a server retry hint.
 *
 * A stub activity 429s for its first three calls (the whole activity retry
 * cycle) carrying `retryAfterMs: 2000`, then succeeds. The workflow's blind
 * park backoff is deliberately much shorter (300-600 ms), so the assertion is
 * TIMING: the agent must resume ~2 s after the failures, not ~0.3 s. A status
 * assertion alone would pass on the blind-backoff code.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx retry-hint-live.ts
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
const taskQueue = `synth-retry-hint-${Date.now()}`;
const HINT_MS = Number(process.env.HINT_MS ?? 2_000);
const BLIND_PARK = { initialMs: 300, maxMs: 600 };
const MIN_WALL_MS = Number(process.env.MIN_WALL_MS ?? HINT_MS - 500);

const callsByAgent = new Map<string, number>();
const callTimesByAgent = new Map<string, number[]>();
const activities = {
  async runTurn(input: { agentId: string }) {
    const call = (callsByAgent.get(input.agentId) ?? 0) + 1;
    callsByAgent.set(input.agentId, call);
    const times = callTimesByAgent.get(input.agentId) ?? [];
    times.push(Date.now());
    callTimesByAgent.set(input.agentId, times);
    if (call <= 3) {
      // What the gateway activity will throw on a 429 once the hint is parsed.
      throw ApplicationFailure.create({
        message: "gateway returned HTTP 429: rate limited",
        type: "RateLimited",
        details: [{ retryAfterMs: HINT_MS }],
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

const agentId = `agt_retry_hint_${Date.now()}`;
const handle = await client.workflow.start(durableAgentWorkflow, {
  taskQueue,
  workflowId: `agent/${agentId}`,
  args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now(), parkBackoff: BLIND_PARK } as DurableAgentState],
});
const startedAt = Date.now();
await handle.signal(sendMessage, { id: "h1", role: "human", text: "rate limited please wait", createdAt: Date.now(), kind: "incident" });

let state: DurableAgentState | undefined;
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  state = await handle.query(getAgentState).catch(() => undefined);
  if (state?.status === "idle" && state.mailbox.length === 0) break;
  await sleep(50);
}
const wallMs = Date.now() - startedAt;
await handle.signal(cancelAgent).catch(() => undefined);
await handle.result().catch(() => undefined);

const calls = callsByAgent.get(agentId) ?? 0;
const times = callTimesByAgent.get(agentId) ?? [];
// The park is the gap between the last failed attempt (call 3) and the turn
// that succeeds (call 4). Total wall time is dominated by the activity retry
// policy (~3s) and would mask the park duration.
const parkGapMs = times.length >= 4 ? times[3]! - times[2]! : -1;
const ok = parkGapMs >= MIN_WALL_MS && state?.status === "idle" && (state?.lastError ?? null) === null;
console.log(
  JSON.stringify(
    {
      address,
      hintMs: HINT_MS,
      blindParkMs: BLIND_PARK,
      minParkGapMs: MIN_WALL_MS,
      parkGapMs,
      wallMs,
      activityCalls: calls,
      callTimesMs: times,
      finalStatus: state?.status ?? "unknown",
      lastError: state?.lastError ?? null,
      honoursHint: parkGapMs >= MIN_WALL_MS,
      ok,
    },
    null,
    2,
  ),
);
await connection.close();
process.exit(ok ? 0 : 1);
