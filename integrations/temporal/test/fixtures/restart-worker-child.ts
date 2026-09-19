/**
 * Child-process worker for the Track 6 restart test. It is spawned, killed
 * mid-activity, and re-spawned by `restart-worker.ts`. Attempt 1 deliberately
 * never heartbeats and hangs; later attempts succeed quickly.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Context as ActivityContext } from "@temporalio/activity";
import { runTemporalWorker } from "../../src/worker.js";

const taskQueue = process.env.TASK_QUEUE;
const attemptsFile = process.env.ATTEMPTS_FILE;
const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
if (!taskQueue || !attemptsFile) throw new Error("TASK_QUEUE and ATTEMPTS_FILE are required");

const activities = {
  async runTurn() {
    const attempt = ActivityContext.current().info.attempt;
    appendFileSync(attemptsFile, `${attempt}\n`);
    if (attempt === 1) {
      // No heartbeat: the 2s heartbeat timeout must detect this and retry.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return { result: "unexpected-first-attempt" };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { result: "recovered" };
  },
};

await runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./restart-probe.ts", import.meta.url)),
  activities,
  taskQueue,
  address,
  namespace,
});
