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

const ok = result === "ok" && sameCodeReplays && changedCodeRejected;
console.log(
  JSON.stringify(
    {
      address,
      workflowResult: result,
      sameCodeReplays,
      sameCodeError: sameCodeError?.slice(0, 300) ?? null,
      changedCodeRejected,
      changedCodeError: changedCodeError?.slice(0, 300) ?? null,
      ok,
    },
    null,
    2,
  ),
);
await connection.close();
process.exit(ok ? 0 : 1);
