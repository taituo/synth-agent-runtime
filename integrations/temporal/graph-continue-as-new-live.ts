/**
 * Live proof: a graph loop crosses `CONTINUE_AS_NEW_AFTER_NODES` and the
 * workflow continues-as-new, then RESUMES and completes with the right counts.
 *
 *   root(loop, until iter.result.count == 1100): body iter(turn)
 *
 * `CONTINUE_AS_NEW_AFTER_NODES` is 1000, so the loop cannot finish in one run.
 * The proof walks the workflow's run chain and asserts:
 *   - at least one `WorkflowExecutionContinuedAsNew` event exists, and each
 *     continued run names the next run id;
 *   - the run that finally completes has no continue-as-new event;
 *   - the final loop count is exactly 1100 iterations, i.e. the resumed run
 *     skipped the 1000 journaled iterations instead of re-running them (the old
 *     behaviour continued-as-new forever without progress).
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx graph-continue-as-new-live.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { runGraphWorkflow } from "./src/graph-workflow.js";
import type { GraphStep } from "./src/graph.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-graph-can-${Date.now()}`;
const eventLog = `/tmp/opencode/graph-can-events-${Date.now()}.jsonl`;
const childScript = fileURLToPath(new URL("./test/fixtures/graph-live-worker-child.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));
const TARGET = 1100;
rmSync(eventLog, { force: true });

const EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW = 28;
const EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED = 2;

interface LogEntry { kind: string; agentId?: string; count?: number; at: number }

function readLog(): LogEntry[] {
  try {
    return readFileSync(eventLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
  } catch {
    return [];
  }
}

function spawnWorker(): ChildProcess {
  return spawn(tsxBin, [childScript], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, TEMPORAL_ADDRESS: address, TEMPORAL_NAMESPACE: namespace, TASK_QUEUE: taskQueue, EVENT_LOG: eventLog },
  });
}

function killWorker(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

const message = (id: string, text: string) => [{ id, role: "human" as const, text, createdAt: 1 }];
const graph: GraphStep = {
  id: "root",
  kind: "loop",
  maxIterations: 5000,
  until: { path: "iter.result.count", equals: TARGET },
  body: { id: "iter", kind: "turn", agentId: "iter", messages: message("iter-1", "iter") },
};

const worker = spawnWorker();
await sleep(2_500);

const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const workflowId = `graph-can/${Date.now()}`;
const handle = await client.workflow.start(runGraphWorkflow, {
  taskQueue,
  workflowId,
  args: [{ graph }],
});

const result = await Promise.race([handle.result(), sleep(240_000).then(() => undefined)]);

// Walk the run chain: each continued run's history ends with a CAN event naming
// the next run id.
interface RunEvent {
  eventType?: number | null;
  workflowExecutionContinuedAsNewEventAttributes?: { newExecutionRunId?: string | null } | null;
}
const runIds: string[] = [];
let runId: string | undefined = handle.firstExecutionRunId;
let continuesAsNew = 0;
let finishedRunCompleted = false;
for (let hop = 0; hop < 10 && runId; hop++) {
  runIds.push(runId);
  const history = await client.workflow.getHandle(workflowId, runId).fetchHistory();
  const events = (history.events ?? []) as RunEvent[];
  const canEvent = events.find((event) => event.eventType === EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW);
  if (canEvent) {
    continuesAsNew += 1;
    runId = String(canEvent.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId ?? "");
    if (!runId) break;
    continue;
  }
  finishedRunCompleted = events.some((event) => event.eventType === EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED);
  break;
}

const iterCalls = readLog().filter((entry) => entry.kind === "turn" && entry.agentId === "iter").length;
const iterCompleted = result?.completed?.filter((id) => id === "iter").length ?? 0;
const distinctIterCounts = new Set(readLog().filter((entry) => entry.kind === "turn" && entry.agentId === "iter").map((entry) => entry.count)).size;

const ok =
  result?.status === "completed"
  && continuesAsNew >= 1
  && finishedRunCompleted
  && iterCalls === TARGET
  && iterCompleted === TARGET
  && distinctIterCounts === TARGET;

console.log(JSON.stringify({
  address,
  taskQueue,
  workflowId,
  target: TARGET,
  status: result?.status ?? "no-result",
  runCount: runIds.length,
  continuesAsNew,
  finishedRunCompleted,
  iterActivityCalls: iterCalls,
  iterCompletedNodes: iterCompleted,
  distinctIterationCounts: distinctIterCounts,
  runIds,
  ok,
}, null, 2));

killWorker(worker);
await connection.close();
process.exit(ok ? 0 : 1);
