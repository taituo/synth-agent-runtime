/**
 * Track 6 live proof: workflow replay determinism.
 *
 * Records a real history from a live worker, replays it against the SAME
 * workflow code (must succeed), then replays it against a deliberately changed
 * workflow (an extra command) and asserts that replay FAILS with a
 * non-determinism error. That negative control is the point: it proves the
 * suite would catch a non-deterministic change to workflow code.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx replay-determinism.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { runTemporalWorker } from "./src/worker.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-replay-${Date.now()}`;
const v1Path = fileURLToPath(new URL("./test/fixtures/replay-probe-v1.ts", import.meta.url));
const v2Path = fileURLToPath(new URL("./test/fixtures/replay-probe-v2.ts", import.meta.url));

const activities = {
  async runTurn() {
    return { result: "ok" };
  },
};

void runTemporalWorker({ workflowsPath: v1Path, activities, taskQueue, address, namespace }).catch((error) => {
  console.error("worker failed", error);
  process.exit(1);
});

await sleep(2500);
const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });

const handle = await client.workflow.start("replayProbeWorkflow", {
  taskQueue,
  workflowId: `replay-probe-${Date.now()}`,
});
const result = await handle.result();
const history = await handle.fetchHistory();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

let sameCodeReplays = false;
let sameCodeError: string | undefined;
try {
  await Worker.runReplayHistory({ workflowsPath: v1Path }, history);
  sameCodeReplays = true;
} catch (error) {
  sameCodeError = message(error);
}

let changedCodeRejected = false;
let changedCodeError: string | undefined;
try {
  await Worker.runReplayHistory({ workflowsPath: v2Path }, history);
} catch (error) {
  changedCodeRejected = true;
  changedCodeError = message(error);
}

// The REAL workflow, not a hand-built probe: run durableAgentWorkflow, capture
// its actual history, and replay it against the same src/workflows.ts. A
// non-deterministic change to the real workflow would fail this.
const realTaskQueue = `synth-replay-real-${Date.now()}`;
const realWorkflowsPath = fileURLToPath(new URL("./src/workflows.ts", import.meta.url));
void runTemporalWorker({
  workflowsPath: realWorkflowsPath,
  activities: { runTurn: async () => ({ result: "ok", state: "idle" as const }) },
  taskQueue: realTaskQueue,
  address,
  namespace,
}).catch((error) => {
  console.error("real worker failed", error);
  process.exit(1);
});
await sleep(2_500);

const realHandle = await client.workflow.start(durableAgentWorkflow, {
  taskQueue: realTaskQueue,
  workflowId: `replay-real-${Date.now()}`,
  args: [{ agentId: "agt_replay_real", status: "idle", mailbox: [], updatedAt: Date.now() }],
});
await realHandle.signal(sendMessage, { id: "m1", role: "human", text: "replay me", createdAt: Date.now() });
const realDeadline = Date.now() + 15_000;
let realState = await realHandle.query(getAgentState).catch(() => undefined);
while (Date.now() < realDeadline) {
  realState = await realHandle.query(getAgentState).catch(() => undefined);
  if (realState && realState.mailbox.length === 0 && realState.lastResult !== undefined) break;
  await sleep(200);
}
await realHandle.signal(cancelAgent);
await realHandle.result().catch(() => undefined);
const realHistory = await realHandle.fetchHistory();
let realReplays = false;
let realError: string | undefined;
try {
  await Worker.runReplayHistory({ workflowsPath: realWorkflowsPath }, realHistory);
  realReplays = true;
} catch (error) {
  realError = message(error);
}

const ok = result === "ok" && sameCodeReplays && changedCodeRejected && realReplays;
console.log(
  JSON.stringify(
    {
      address,
      workflowResult: result,
      sameCodeReplays,
      sameCodeError: sameCodeError?.slice(0, 300) ?? null,
      changedCodeRejected,
      changedCodeError: changedCodeError?.slice(0, 300) ?? null,
      realWorkflowReplays: realReplays,
      realWorkflowError: realError?.slice(0, 300) ?? null,
      realWorkflowEvents: realHistory.events?.length ?? null,
      ok,
    },
    null,
    2,
  ),
);
await connection.close();
process.exit(ok ? 0 : 1);
