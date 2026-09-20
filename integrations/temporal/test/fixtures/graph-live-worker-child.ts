/**
 * Child worker shared by the graph live proofs (child workflow, continue-as-new,
 * cancel). It runs the graph workflow (`src/graph-workflow.ts`) and the two
 * activities a graph can dispatch.
 *
 * Every `runTurn`/`graphActivity` invocation appends a JSON line to `EVENT_LOG`,
 * so a driver can assert activity call counts and ordering. `SLOW_AGENTS` (a
 * comma-separated list of agent ids) makes those turns sleep `SLOW_MS` so a
 * driver can cancel a real in-flight loop.
 */
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Context as ActivityContext } from "@temporalio/activity";
import { runTemporalWorker } from "../../src/worker.js";

const taskQueue = process.env.TASK_QUEUE;
const eventLog = process.env.EVENT_LOG;
const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const slowAgents = new Set((process.env.SLOW_AGENTS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const slowMs = Number(process.env.SLOW_MS ?? 200);
if (!taskQueue || !eventLog) throw new Error("TASK_QUEUE and EVENT_LOG are required");

const counters = new Map<string, number>();

const activities = {
  async runTurn(input: { agentId: string; messages: Array<{ id: string; text: string }> }) {
    const attempt = ActivityContext.current().info.attempt;
    const count = (counters.get(input.agentId) ?? 0) + 1;
    counters.set(input.agentId, count);
    appendFileSync(eventLog, `${JSON.stringify({ kind: "turn", agentId: input.agentId, attempt, count, texts: input.messages.map((message) => message.text), at: Date.now() })}\n`);
    if (slowAgents.has(input.agentId)) await sleep(slowMs);
    ActivityContext.current().heartbeat();
    return { result: { count, agentId: input.agentId }, state: "idle" as const };
  },
  async graphActivity(input: { name: string }) {
    appendFileSync(eventLog, `${JSON.stringify({ kind: "activity", name: input.name, attempt: ActivityContext.current().info.attempt, at: Date.now() })}\n`);
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
