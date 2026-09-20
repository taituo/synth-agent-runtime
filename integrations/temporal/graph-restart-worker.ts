/**
 * Graph restart-resilience proof: run a graph with a LOOP and a FAN-OUT/JOIN,
 * SIGKILL the worker mid-graph, and show committed nodes are not re-run.
 *
 * Graph (a sequence):
 *   pre -> loop(iter until iter.result.count == 3) -> fanout(left, right) -> hang
 *
 * `hang` blocks on attempt 1 with no heartbeat. It runs AFTER the join, so the
 * workflow task that scheduled it had already persisted the loop and join
 * results; the driver kills the worker with `hang` in flight. On a fresh worker
 * the graph workflow replays and Temporal retries only that turn. Discriminating
 * quantities are the per-node activity call counts:
 *   pre=1, iter=3 (loop committed), left=1, right=1 (join committed),
 *   hang=2 (in-flight retried: attempts [1, 2]).
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx graph-restart-worker.ts
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
const taskQueue = `synth-graph-restart-${Date.now()}`;
const attemptsFile = `/tmp/opencode/graph-restart-attempts-${Date.now()}.txt`;
const childScript = fileURLToPath(new URL("./test/fixtures/graph-restart-worker-child.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));
rmSync(attemptsFile, { force: true });

interface Attempt { agentId: string; attempt: number; count: number; texts: string[] }

function readAttempts(): Attempt[] {
  try {
    return readFileSync(attemptsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Attempt);
  } catch {
    return [];
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function spawnWorker(): ChildProcess {
  return spawn(tsxBin, [childScript], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, TEMPORAL_ADDRESS: address, TEMPORAL_NAMESPACE: namespace, TASK_QUEUE: taskQueue, ATTEMPTS_FILE: attemptsFile },
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
  kind: "sequence",
  steps: [
    { id: "pre", kind: "turn", agentId: "pre", messages: message("pre-1", "pre") },
    {
      id: "loop",
      kind: "loop",
      maxIterations: 5,
      until: { path: "iter.result.count", equals: 3 },
      body: { id: "iter", kind: "turn", agentId: "iter", messages: message("iter-1", "iter") },
    },
    {
      id: "join",
      kind: "fanout",
      steps: [
        { id: "left", kind: "turn", agentId: "left", messages: message("left-1", "left") },
        { id: "right", kind: "turn", agentId: "right", messages: message("right-1", "right") },
      ],
    },
    { id: "hang", kind: "turn", agentId: "hang", messages: message("hang-1", "hang") },
  ],
};

const first = spawnWorker();
await sleep(2_500);

const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const agentId = `graph_restart_${Date.now()}`;
const handle = await client.workflow.start(runGraphWorkflow, {
  taskQueue,
  workflowId: `graph/${agentId}`,
  args: [{ graph }],
});

// The loop and the join must commit; `hang` blocks on attempt 1.
await waitFor(() => {
  const attempts = readAttempts();
  return attempts.some((entry) => entry.agentId === "hang" && entry.attempt === 1)
    && attempts.filter((entry) => entry.agentId === "iter").length >= 3
    && attempts.some((entry) => entry.agentId === "left")
    && attempts.some((entry) => entry.agentId === "right");
}, 30_000, "the graph to reach the hanging node after the join");
killWorker(first);

const second = spawnWorker();
await waitFor(() => readAttempts().some((entry) => entry.agentId === "hang" && entry.attempt >= 2), 150_000, "the in-flight node to retry after restart");

const result = await Promise.race([handle.result(), sleep(60_000).then(() => undefined)]);
const attempts = readAttempts();
const countOf = (agentId: string) => attempts.filter((entry) => entry.agentId === agentId).length;
const iterCalls = countOf("iter");
const preCalls = countOf("pre");
const leftCalls = countOf("left");
const rightCalls = countOf("right");
const hangCalls = countOf("hang");
const completedIter = result?.completed.filter((id) => id === "iter").length ?? 0;

const ok =
  result?.status === "completed"
  && preCalls === 1
  && iterCalls === 3
  && leftCalls === 1
  && rightCalls === 1
  && hangCalls === 2
  && completedIter === 3;

console.log(JSON.stringify({
  address,
  taskQueue,
  status: result?.status ?? "no-result",
  preCalls,
  iterCalls,
  leftCalls,
  rightCalls,
  hangCalls,
  attempts: attempts.map((entry) => `${entry.agentId}#${entry.attempt}`),
  completedIterations: completedIter,
  committedNodesNotRerun: preCalls === 1 && iterCalls === 3 && leftCalls === 1 && rightCalls === 1,
  inFlightNodeRetried: hangCalls === 2,
  completed: result?.completed ?? [],
  ok,
}, null, 2));

killWorker(second);
await connection.close();
process.exit(ok ? 0 : 1);
