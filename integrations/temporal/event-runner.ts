/**
 * Shared worker/client harness for the scripted event drivers.
 *
 * Both `event-driver.ts` (single-agent deterministic replay) and
 * `swarm-driver.ts` (concurrent agents) start one worker, drive one or more
 * durable workflows with a `ScriptedEvent` schedule, and inspect the resulting
 * trace + worker logs.
 */
import { appendFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Context as ActivityContext, log as activityLog } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { DefaultLogger, Runtime } from "@temporalio/worker";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import type { AgentActivities } from "./src/contracts.js";
import { runTemporalWorker } from "./src/worker.js";
import {
  projectFinalState,
  sequenceFromTrace,
  type LogLikeEntry,
  type ScriptedEvent,
  type TraceLikeEvent,
} from "./event-script.js";

let runtimeInstalled = false;

export interface EventRunner {
  client: Client;
  trace: TraceLikeEvent[];
  logs: LogLikeEntry[];
  traceFile: string;
  taskQueue: string;
  close(): Promise<void>;
}

export interface StartEventRunnerOptions {
  address?: string;
  namespace?: string;
  traceFile?: string;
  taskQueue?: string;
  /** Wait after starting the worker before connecting (default 2500ms). */
  warmupMs?: number;
  /** Activities the worker runs. Defaults to the instant echo stub. */
  activities?: AgentActivities;
}

const activities = {
  async runTurn({ messages }: { agentId: string; messages: Array<{ text?: string; kind?: string }> }) {
    const attempt = ActivityContext.current().info.attempt;
    const last = messages[messages.length - 1]?.text;
    activityLog.info("synth.activity.runTurn", { attempt, text: last });
    // Stay idle so the workflow keeps running across the whole event schedule.
    return { result: `echo:${last}`, state: "idle" as const };
  },
};

export async function startEventRunner(options: StartEventRunnerOptions = {}): Promise<EventRunner> {
  const address = options.address ?? process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
  const namespace = options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? "default";
  const traceFile =
    options.traceFile ?? process.env.TRACE_FILE ?? `/tmp/opencode/temporal-event-driver-${Date.now()}.jsonl`;
  const taskQueue = options.taskQueue ?? `synth-event-driver-${Date.now()}`;
  rmSync(traceFile, { force: true });

  const trace: TraceLikeEvent[] = [];
  const logs: LogLikeEntry[] = [];
  // Temporal allows a single Runtime per process; a driver that starts several
  // runners (e.g. one per model) must not call install() again.
  if (!runtimeInstalled) {
    Runtime.install({
      logger: new DefaultLogger("INFO", (entry) => {
        logs.push({ message: entry.message, meta: entry.meta as Record<string, unknown> | undefined });
      }),
    });
    runtimeInstalled = true;
  }

  void runTemporalWorker({
    workflowsPath: fileURLToPath(new URL("./src/workflows.ts", import.meta.url)),
    workflowInterceptorModules: [fileURLToPath(new URL("./src/workflow-interceptors.ts", import.meta.url))],
    activities: options.activities ?? activities,
    taskQueue,
    address,
    namespace,
    interceptors: {
      trace: {
        emit(event) {
          trace.push(event as TraceLikeEvent);
          appendFileSync(traceFile, `${JSON.stringify(event)}\n`);
        },
      },
    },
  }).catch((error) => {
    console.error("worker failed", error);
    process.exit(1);
  });

  await sleep(options.warmupMs ?? 2500);
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });
  return {
    client,
    trace,
    logs,
    traceFile,
    taskQueue,
    async close() {
      await connection.close();
    },
  };
}

export async function waitForProcessed(
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

export async function runScript(runner: EventRunner, agentId: string, script: readonly ScriptedEvent[]) {
  const handle = await runner.client.workflow.start(durableAgentWorkflow, {
    taskQueue: runner.taskQueue,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now() }],
  });

  for (const event of script) {
    if (event.delayMs > 0) await sleep(event.delayMs);
    await handle.signal(sendMessage, {
      id: `${agentId}-${event.kind}-${Math.random().toString(36).slice(2)}`,
      role: "human",
      text: event.text,
      createdAt: Date.now(),
      kind: event.kind,
    });
  }

  await waitForProcessed(runner.trace, agentId, script.length);
  await sleep(150); // let the final turn's state splice settle
  const state = await handle.query(getAgentState);
  await handle.signal(cancelAgent);
  await handle.result().catch(() => undefined);
  return { agentId, final: projectFinalState(state), processed: sequenceFromTrace(runner.trace, agentId) };
}
