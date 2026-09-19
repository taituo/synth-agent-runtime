/**
 * Live proof that Synth correlation ids ride along on Temporal telemetry.
 *
 * Requires a Temporal dev server. Verified against
 * `temporal server start-dev --port 7243` (namespace `default`).
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx interceptors-live.ts
 *
 * It runs a real worker (with the Synth activity + workflow interceptors),
 * drives two workflows (one happy path, one that fails once and succeeds on
 * retry), and then asserts that:
 *   - the trace sink received activity spans carrying agentId/workflowId/attempt,
 *   - the retry attempt carries `retryReason` and the failure carries `willRetry`,
 *   - worker log lines carry the same correlation fields.
 */
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Context as ActivityContext, log as activityLog } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { DefaultLogger, Runtime, type LogEntry } from "@temporalio/worker";
import { durableAgentWorkflow, sendMessage } from "./src/workflows.js";
import { runTemporalWorker } from "./src/worker.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const TRACE_FILE = process.env.TRACE_FILE ?? `/tmp/opencode/temporal-interceptors-${Date.now()}.jsonl`;
const TASK_QUEUE = `synth-interceptors-${Date.now()}`;

const logs: LogEntry[] = [];
const traceSink = {
  emit(event: Record<string, unknown>) {
    appendFileSync(TRACE_FILE, `${JSON.stringify(event)}\n`);
  },
};

const activities = {
  async runTurn({ agentId, messages }: { agentId: string; messages: Array<{ text?: string }> }) {
    const attempt = ActivityContext.current().info.attempt;
    const last = messages[messages.length - 1]?.text;
    activityLog.info("synth.activity.runTurn", { attempt, text: last });
    if (last === "flaky" && attempt < 2) throw new Error("synthetic flaky failure");
    if (last === "flaky") return { result: `flaky-ok:${attempt}`, state: "completed" as const };
    if (last === "finish") return { result: `done:${messages.length}`, state: "completed" as const };
    return { result: `echo:${last}`, state: "idle" as const };
  },
};

rmSync(TRACE_FILE, { force: true });
Runtime.install({ logger: new DefaultLogger("DEBUG", (entry) => { logs.push(entry); }) });

void runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./src/workflows.ts", import.meta.url)),
  workflowInterceptorModules: [fileURLToPath(new URL("./src/workflow-interceptors.ts", import.meta.url))],
  activities,
  taskQueue: TASK_QUEUE,
  address,
  namespace,
  interceptors: {
    trace: traceSink,
    maxAttempts: 3,
    traceIdFor: (correlation) => `synth:${correlation.agentId ?? correlation.workflowId ?? "unknown"}`,
  },
}).catch((error) => {
  console.error("worker failed", error);
  process.exit(1);
});

await sleep(2500);
const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });

function makeMessage(text: string) {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role: "human" as const, text, createdAt: Date.now() };
}

async function runAgent(agentId: string, text: string, timeoutMs = 30000) {
  const handle = await client.workflow.start(durableAgentWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now() }],
  });
  await handle.signal(sendMessage, makeMessage(text));
  return Promise.race([handle.result(), sleep(timeoutMs).then(() => ({ status: "timeout" as const }))]);
}

const happyId = `agt_happy_${Date.now()}`;
const flakyId = `agt_flaky_${Date.now()}`;
const happy = await runAgent(happyId, "finish");
const flaky = await runAgent(flakyId, "flaky");

const events = readFileSync(TRACE_FILE, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
  traceId: string; name: string; phase: string; attributes: Record<string, unknown>;
});
const byAgent = (id: string) => events.filter((event) => event.attributes.agentId === id);
const flakyEvents = byAgent(flakyId);
const retryStart = flakyEvents.find((event) => event.phase === "start" && event.attributes.attempt === 2);
const failure = flakyEvents.find((event) => event.phase === "error");
const logHits = logs.filter((entry) => entry.meta && typeof entry.meta === "object" && "agentId" in entry.meta);
const workflowLogHits = logHits.filter((entry) => entry.meta?.sdkComponent === "workflow");
const activityLogHits = logHits.filter((entry) => entry.meta?.sdkComponent === "activity");

const report = {
  address,
  traceFile: TRACE_FILE,
  happy: { status: happy.status, result: (happy as { lastResult?: unknown }).lastResult },
  flaky: { status: flaky.status, result: (flaky as { lastResult?: unknown }).lastResult },
  trace: {
    totalEvents: events.length,
    happyAgentEvents: byAgent(happyId).length,
    happyTraceId: byAgent(happyId)[0]?.traceId,
    retryAttemptSeen: retryStart?.attributes.attempt ?? null,
    retryReasonOnRetry: retryStart?.attributes.retryReason ?? null,
    failureWillRetry: failure?.attributes.willRetry ?? null,
    failureError: failure?.attributes.error ?? null,
  },
  workerLogs: {
    withAgentId: logHits.length,
    workflowComponent: workflowLogHits.length,
    activityComponent: activityLogHits.length,
    sample: logHits[0]?.meta ?? null,
  },
};

const ok =
  happy.status === "completed" &&
  flaky.status === "completed" &&
  retryStart !== undefined &&
  retryStart.attributes.retryReason === "synthetic flaky failure" &&
  failure?.attributes.willRetry === true &&
  byAgent(happyId).length >= 2 &&
  logHits.length > 0 &&
  workflowLogHits.length > 0 &&
  activityLogHits.length > 0;

console.log(JSON.stringify({ ...report, ok }, null, 2));
await connection.close();
process.exit(ok ? 0 : 1);
