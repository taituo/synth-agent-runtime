/**
 * Live proof: `cancelGraph` stops a graph stuck in a real long loop.
 *
 *   root(loop, maxIterations 100000, until never): body iter(turn, ~200ms)
 *
 * The driver waits until the loop has actually advanced, sends `cancelGraph`
 * while a turn is in flight, and asserts the loop counter STOPS:
 *   - the final activity call count is at most one more than at cancel time
 *     (the in-flight node finishes, then the loop unwinds) and far below
 *     `maxIterations`;
 *   - the count does not advance after the workflow has returned;
 *   - the returned state is `cancelled` and its completed-node count matches.
 * A status alone is not evidence; the bounded counter is.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx graph-cancel-live.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { cancelGraph, runGraphWorkflow } from "./src/graph-workflow.js";
import type { GraphStep } from "./src/graph.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-graph-cancel-${Date.now()}`;
const eventLog = `/tmp/opencode/graph-cancel-events-${Date.now()}.jsonl`;
const childScript = fileURLToPath(new URL("./test/fixtures/graph-live-worker-child.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));
const MAX_ITERATIONS = 100000;
const SLOW_MS = 200;
rmSync(eventLog, { force: true });

function iterCalls(): number {
  try {
    return readFileSync(eventLog, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; agentId?: string })
      .filter((entry) => entry.kind === "turn" && entry.agentId === "iter").length;
  } catch {
    return 0;
  }
}

function spawnWorker(): ChildProcess {
  return spawn(tsxBin, [childScript], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      TEMPORAL_ADDRESS: address,
      TEMPORAL_NAMESPACE: namespace,
      TASK_QUEUE: taskQueue,
      EVENT_LOG: eventLog,
      SLOW_AGENTS: "iter",
      SLOW_MS: String(SLOW_MS),
    },
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
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const message = (id: string, text: string) => [{ id, role: "human" as const, text, createdAt: 1 }];
const graph: GraphStep = {
  id: "root",
  kind: "loop",
  maxIterations: MAX_ITERATIONS,
  until: { path: "iter.result.count", equals: -1 },
  body: { id: "iter", kind: "turn", agentId: "iter", messages: message("iter-1", "iter") },
};

const worker = spawnWorker();
await sleep(2_500);

const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const workflowId = `graph-cancel/${Date.now()}`;
const handle = await client.workflow.start(runGraphWorkflow, { taskQueue, workflowId, args: [{ graph }] });

// Wait until the loop has genuinely advanced, then cancel mid-run.
await waitFor(() => iterCalls() >= 3, 30_000, "the loop to advance");
const countAtCancel = iterCalls();
await handle.signal(cancelGraph);
const result = await Promise.race([handle.result(), sleep(30_000).then(() => undefined)]);
const countAtReturn = iterCalls();
await sleep(1_000);
const countLater = iterCalls();

const iterCompleted = result?.completed?.filter((id) => id === "iter").length ?? -1;
const stopped = countLater === countAtReturn;
const bounded = countLater - countAtCancel <= 1;

const ok =
  result?.status === "cancelled"
  && bounded
  && stopped
  && countLater < MAX_ITERATIONS
  && iterCompleted === countLater;

console.log(JSON.stringify({
  address,
  taskQueue,
  workflowId,
  maxIterations: MAX_ITERATIONS,
  status: result?.status ?? "no-result",
  countAtCancel,
  countAtReturn,
  countLater,
  advancedByAtMostOne: bounded,
  counterStopped: stopped,
  iterCompletedNodes: iterCompleted,
  finalIterations: result?.iteration ?? null,
  ok,
}, null, 2));

killWorker(worker);
await connection.close();
process.exit(ok ? 0 : 1);
