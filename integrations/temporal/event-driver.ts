/**
 * Scripted typed-event driver for the durable agent workflow.
 *
 * A runnable tool (not part of the library) that fires a fixed, ordered
 * schedule of typed signals into one running `durableAgentWorkflow`, with
 * realistic spacing between events. Running it twice asserts deterministic
 * replay: the same input must yield the same processed-signal sequence and the
 * same (volatile-field-free) final state.
 *
 * Requires a Temporal dev server (verified against
 * `temporal server start-dev --port 7243`, namespace `default`):
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx event-driver.ts
 */
import { appendFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context as ActivityContext, log as activityLog } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { DefaultLogger, Runtime } from "@temporalio/worker";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { runTemporalWorker } from "./src/worker.js";
import {
  EVENT_SCRIPT,
  isDeterministicReplay,
  projectFinalState,
  sequenceFromTrace,
  type TraceLikeEvent,
} from "./event-script.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const TRACE_FILE = process.env.TRACE_FILE ?? `/tmp/opencode/temporal-event-driver-${Date.now()}.jsonl`;
const TASK_QUEUE = `synth-event-driver-${Date.now()}`;

const activities = {
  async runTurn({ messages }: { agentId: string; messages: Array<{ text?: string; kind?: string }> }) {
    const attempt = ActivityContext.current().info.attempt;
    const last = messages[messages.length - 1]?.text;
    activityLog.info("synth.activity.runTurn", { attempt, text: last });
    // Stay idle so the workflow keeps running across the whole event schedule.
    return { result: `echo:${last}`, state: "idle" as const };
  },
};

async function waitForProcessed(
  trace: TraceLikeEvent[],
  agentId: string,
  expected: number,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sequenceFromTrace(trace, agentId).length >= expected) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${expected} processed turns for ${agentId}`);
}

async function runEventScript(client: Client, trace: TraceLikeEvent[], agentId: string) {
  const handle = await client.workflow.start(durableAgentWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now() }],
  });

  for (const event of EVENT_SCRIPT) {
    if (event.delayMs > 0) await sleep(event.delayMs);
    await handle.signal(sendMessage, {
      id: `${agentId}-${event.kind}-${Math.random().toString(36).slice(2)}`,
      role: "human",
      text: event.text,
      createdAt: Date.now(),
      kind: event.kind,
    });
  }

  await waitForProcessed(trace, agentId, EVENT_SCRIPT.length);
  await sleep(150); // let the final turn's state splice settle
  const state = await handle.query(getAgentState);
  await handle.signal(cancelAgent);
  await handle.result().catch(() => undefined);
  return { agentId, final: projectFinalState(state), processed: sequenceFromTrace(trace, agentId) };
}

export async function main(): Promise<void> {
  rmSync(TRACE_FILE, { force: true });
  const trace: TraceLikeEvent[] = [];
  Runtime.install({ logger: new DefaultLogger("WARN", () => {}) });

  void runTemporalWorker({
    workflowsPath: fileURLToPath(new URL("./src/workflows.ts", import.meta.url)),
    workflowInterceptorModules: [fileURLToPath(new URL("./src/workflow-interceptors.ts", import.meta.url))],
    activities,
    taskQueue: TASK_QUEUE,
    address,
    namespace,
    interceptors: {
      trace: {
        emit(event) {
          trace.push(event as TraceLikeEvent);
          appendFileSync(TRACE_FILE, `${JSON.stringify(event)}\n`);
        },
      },
    },
  }).catch((error) => {
    console.error("worker failed", error);
    process.exit(1);
  });

  await sleep(2500);
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const stamp = Date.now();
  const runA = await runEventScript(client, trace, `agt_script_a_${stamp}`);
  const runB = await runEventScript(client, trace, `agt_script_b_${stamp}`);

  const deterministic = isDeterministicReplay(runA, runB);
  const expected = EVENT_SCRIPT.map((event) => event.kind);
  const scriptOk = JSON.stringify(runA.processed) === JSON.stringify(expected);

  console.log(
    JSON.stringify(
      { address, traceFile: TRACE_FILE, script: EVENT_SCRIPT, runA, runB, expected, deterministic, scriptOk, ok: deterministic && scriptOk },
      null,
      2,
    ),
  );
  await connection.close();
  process.exit(deterministic && scriptOk ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
