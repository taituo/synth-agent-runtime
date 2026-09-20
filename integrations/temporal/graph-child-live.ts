/**
 * Live proof: a graph node runs a REAL child workflow and the parent waits on it.
 *
 *   root(sequence): pre(turn) -> sub(child graph) -> after(turn)
 *
 * `sub` is a `child` node with `workflow: "graph"`, dispatched by
 * `executeChild(runGraphWorkflow, ...)` in `src/graph-workflow.ts`. The nested
 * graph runs on the same worker as a separate workflow execution.
 *
 * Discriminating quantities (asserted, not a status):
 *   - the parent's history contains a `StartChildWorkflowExecutionInitiated`
 *     event whose `workflowType.name` is `runGraphWorkflow`, with a child
 *     `workflowId` different from the parent's, followed by
 *     `ChildWorkflowExecutionStarted` and `ChildWorkflowExecutionCompleted`;
 *   - the parent's own result embeds the child's `GraphRunState` (the parent
 *     value depends on the child), and the activity log confirms the child's
 *     inner nodes ran between the parent's `pre` and `after`.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx graph-child-live.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection, type WorkflowHandle } from "@temporalio/client";
import { runGraphWorkflow } from "./src/graph-workflow.js";
import type { GraphStep } from "./src/graph.js";

/** `temporal.api.enums.v1.EventType` values (the package's ESM build exposes no named export). */
const EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED = 29;
const EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED = 31;
const EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_COMPLETED = 32;

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-graph-child-${Date.now()}`;
const eventLog = `/tmp/opencode/graph-child-events-${Date.now()}.jsonl`;
const childScript = fileURLToPath(new URL("./test/fixtures/graph-live-worker-child.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));
rmSync(eventLog, { force: true });

interface LogEntry { kind: string; agentId?: string; name?: string; texts?: string[]; at: number }

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

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const message = (id: string, text: string) => [{ id, role: "human" as const, text, createdAt: 1 }];
const graph: GraphStep = {
  id: "root",
  kind: "sequence",
  steps: [
    { id: "pre", kind: "turn", agentId: "pre", messages: message("pre-1", "pre") },
    {
      id: "sub",
      kind: "child",
      workflow: "graph",
      graph: {
        id: "inner",
        kind: "sequence",
        steps: [
          { id: "inner-a", kind: "turn", agentId: "inner-a", messages: message("inner-a-1", "inner-a") },
          { id: "inner-b", kind: "activity", name: "inner-b" },
        ],
      },
    },
    { id: "after", kind: "turn", agentId: "after", messages: message("after-1", "after") },
  ],
};

const worker = spawnWorker();
await sleep(2_500);

const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const parentId = `graph-child/${Date.now()}`;
const handle: WorkflowHandle<typeof runGraphWorkflow> = await client.workflow.start(runGraphWorkflow, {
  taskQueue,
  workflowId: parentId,
  args: [{ graph }],
});

const result = await Promise.race([handle.result(), sleep(60_000).then(() => undefined)]);
await waitFor(() => readLog().some((entry) => entry.kind === "turn" && entry.agentId === "after"), 10_000, "the parent's after node");

const history = await handle.fetchHistory();
const events = history.events ?? [];
const childInitiated = events.find((event) =>
  event.eventType === EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED
  && event.startChildWorkflowExecutionInitiatedEventAttributes?.workflowType?.name === "runGraphWorkflow");
const childWorkflowId = childInitiated?.startChildWorkflowExecutionInitiatedEventAttributes?.workflowId ?? null;
const childStarted = events.some((event) =>
  event.eventType === EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED
  && event.childWorkflowExecutionStartedEventAttributes?.workflowExecution?.workflowId === childWorkflowId);
const childCompleted = events.some((event) =>
  event.eventType === EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_COMPLETED
  && event.childWorkflowExecutionCompletedEventAttributes?.workflowExecution?.workflowId === childWorkflowId);

const sub = (result?.results?.sub ?? undefined) as { status?: string; completed?: string[] } | undefined;
const log = readLog();
const order = log.filter((entry) => entry.kind === "turn" || entry.kind === "activity").map((entry) => entry.agentId ?? `activity:${entry.name}`);
const expectedOrder = ["pre", "inner-a", "activity:inner-b", "after"];

const ok =
  result?.status === "completed"
  && result.completed?.join(",") === "pre,sub,after,root"
  && sub?.status === "completed"
  && (sub.completed ?? []).includes("inner-a")
  && (sub.completed ?? []).includes("inner-b")
  && childInitiated !== undefined
  && childWorkflowId !== null
  && childWorkflowId !== parentId
  && childStarted
  && childCompleted
  && order.join(",") === expectedOrder.join(",");

console.log(JSON.stringify({
  address,
  taskQueue,
  parentWorkflowId: parentId,
  status: result?.status ?? "no-result",
  parentCompleted: result?.completed ?? [],
  childWorkflowType: childInitiated?.startChildWorkflowExecutionInitiatedEventAttributes?.workflowType?.name ?? null,
  childWorkflowId,
  childIsDistinctExecution: childWorkflowId !== null && childWorkflowId !== parentId,
  childStartedEvent: childStarted,
  childCompletedEvent: childCompleted,
  childReportedStatus: sub?.status ?? null,
  childCompletedNodes: sub?.completed ?? [],
  activityOrder: order,
  expectedOrder,
  ok,
}, null, 2));

killWorker(worker);
await connection.close();
process.exit(ok ? 0 : 1);
