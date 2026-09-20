/**
 * Child worker for the durable-restart proof. It runs the REAL
 * `durableAgentWorkflow` (not a probe) and is spawned, SIGKILLed mid-turn, and
 * re-spawned by `durable-restart-worker.ts`.
 *
 * The activity appends every invocation to `ATTEMPTS_FILE`, so the driver can
 * assert per-message call counts across the kill. A batch containing the text
 * "hang" deliberately never heartbeats on attempt 1 and blocks forever: the
 * workflow's 1-minute heartbeat timeout must detect the dead worker and retry
 * the SAME turn on the restarted worker, while already-committed turns are not
 * re-run.
 */
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Context as ActivityContext } from "@temporalio/activity";
import { runTemporalWorker } from "../../src/worker.js";

const taskQueue = process.env.TASK_QUEUE;
const attemptsFile = process.env.ATTEMPTS_FILE;
const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
if (!taskQueue || !attemptsFile) throw new Error("TASK_QUEUE and ATTEMPTS_FILE are required");

const activities = {
  async runTurn(input: { agentId: string; messages: Array<{ id: string; text: string }> }) {
    const attempt = ActivityContext.current().info.attempt;
    const texts = input.messages.map((message) => message.text);
    appendFileSync(attemptsFile, `${JSON.stringify({ attempt, ids: input.messages.map((message) => message.id), texts })}\n`);
    if (texts.includes("hang") && attempt === 1) {
      // No heartbeat: the workflow's 1-minute heartbeat timeout must notice.
      await new Promise<never>(() => {});
    }
    await sleep(200);
    return { result: `ok:${input.messages.length}`, state: "idle" as const };
  },
};

await runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("../../src/workflows.ts", import.meta.url)),
  workflowInterceptorModules: [fileURLToPath(new URL("../../src/workflow-interceptors.ts", import.meta.url))],
  activities,
  taskQueue,
  address,
  namespace,
});
