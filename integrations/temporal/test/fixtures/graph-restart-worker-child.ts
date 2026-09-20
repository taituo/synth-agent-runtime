/**
 * Child worker for the graph restart proof. It runs the graph workflow
 * (`src/graph-workflow.ts`) and is spawned, SIGKILLed mid-graph, and
 * re-spawned by `graph-restart-worker.ts`.
 *
 * `runTurn` appends every invocation to `ATTEMPTS_FILE` (per-node call counts).
 * The `hang` node (which runs AFTER the loop and the join) never heartbeats on
 * attempt 1 and blocks forever, so the driver can kill the worker with that
 * turn in flight. Because the workflow task that scheduled `hang` atomically
 * persisted the loop and join results, the proof shows those committed nodes
 * are not re-run.
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

const counters = new Map<string, number>();

const activities = {
  async runTurn(input: { agentId: string; messages: Array<{ id: string; text: string }> }) {
    const attempt = ActivityContext.current().info.attempt;
    const count = (counters.get(input.agentId) ?? 0) + 1;
    counters.set(input.agentId, count);
    appendFileSync(attemptsFile, `${JSON.stringify({ agentId: input.agentId, attempt, count, texts: input.messages.map((m) => m.text) })}\n`);
    if (input.agentId === "hang" && attempt === 1) {
      // No heartbeat: the graph's 1-minute heartbeat timeout must notice.
      await new Promise<never>(() => {});
    }
    await sleep(150);
    return { result: { count }, state: "idle" as const };
  },
  async graphActivity(input: { name: string }) {
    appendFileSync(attemptsFile, `${JSON.stringify({ agentId: `activity:${input.name}`, attempt: ActivityContext.current().info.attempt, count: 1, texts: [] })}\n`);
    return { name: input.name };
  },
};

await runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("../../src/graph-workflow.ts", import.meta.url)),
  workflowInterceptorModules: [fileURLToPath(new URL("../../src/workflow-interceptors.ts", import.meta.url))],
  activities,
  taskQueue,
  address,
  namespace,
});
