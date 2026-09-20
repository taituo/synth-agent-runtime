/**
 * Durable-resume proof: SIGKILL a worker running the REAL `durableAgentWorkflow`
 * mid-turn and show that, on resume, committed turns are NOT re-run.
 *
 * Sequence:
 *   1. send message A ("committed") -> turn 1 runs and commits (mailbox spliced).
 *   2. send message B ("hang")      -> turn 2 starts and blocks forever with no
 *      heartbeat; SIGKILL the worker while that activity is in flight.
 *   3. start a fresh worker -> the 1-minute heartbeat timeout fires, Temporal
 *      retries turn 2 (attempt 2) on the new worker, and the workflow drains.
 *
 * The discriminating quantities are per-message activity call counts:
 *   committedCalls === 1   (the committed turn was not re-derived after the kill)
 *   hangCalls === 2        (the in-flight turn was retried: attempts [1, 2])
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx durable-restart-worker.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-durable-restart-${Date.now()}`;
const attemptsFile = `/tmp/opencode/durable-restart-attempts-${Date.now()}.txt`;
const childScript = fileURLToPath(new URL("./test/fixtures/durable-restart-worker-child.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));
rmSync(attemptsFile, { force: true });

interface Attempt { attempt: number; ids: string[]; texts: string[] }

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

const first = spawnWorker();
await sleep(2_500);

const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const agentId = `agt_durable_restart_${Date.now()}`;
const handle = await client.workflow.start(durableAgentWorkflow, {
  taskQueue,
  workflowId: `agent/${agentId}`,
  args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now() }],
});

// 1. Turn A commits.
await handle.signal(sendMessage, { id: `${agentId}-A`, role: "human", text: "committed", createdAt: Date.now() });
await waitFor(() => readAttempts().some((entry) => entry.texts.includes("committed")), 20_000, "committed turn to start");
await waitFor(async () => {
  const state = await handle.query(getAgentState);
  return state.status === "idle" && state.mailbox.length === 0;
}, 20_000, "committed turn to drain");

// 2. Turn B hangs on attempt 1; kill the worker while it is in flight.
await handle.signal(sendMessage, { id: `${agentId}-B`, role: "human", text: "hang", createdAt: Date.now() });
await waitFor(() => readAttempts().some((entry) => entry.texts.includes("hang") && entry.attempt === 1), 20_000, "hung turn to start");
killWorker(first);

// 3. A fresh worker must retry the in-flight turn after the heartbeat timeout.
const second = spawnWorker();
await waitFor(() => readAttempts().some((entry) => entry.texts.includes("hang") && entry.attempt >= 2), 150_000, "retried turn after restart");
await waitFor(async () => {
  const state = await handle.query(getAgentState);
  return state.status === "idle" && state.mailbox.length === 0;
}, 30_000, "recovered workflow to drain");

const finalState = await handle.query(getAgentState);
await handle.signal(cancelAgent);
const result = await handle.result().catch(() => undefined);
const lines = readAttempts();
const committedCalls = lines.filter((entry) => entry.texts.includes("committed")).length;
const hangCalls = lines.filter((entry) => entry.texts.includes("hang")).length;
const committedNotRerun = committedCalls === 1;
const hungTurnRetried = hangCalls === 2;
const drained = finalState.status === "idle" && finalState.mailbox.length === 0;
const ok = committedNotRerun && hungTurnRetried && drained;

console.log(JSON.stringify({
  address,
  taskQueue,
  committedCalls,
  hangCalls,
  attempts: lines.map((entry) => entry.attempt),
  committedNotRerun,
  hungTurnRetried,
  finalStatus: finalState.status,
  mailboxLength: finalState.mailbox.length,
  cancelledResult: result !== undefined,
  ok,
}, null, 2));

killWorker(second);
await connection.close();
process.exit(ok ? 0 : 1);
