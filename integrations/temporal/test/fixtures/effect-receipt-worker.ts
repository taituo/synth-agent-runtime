/**
 * Child worker for the effect-receipt live proof. It runs the shipped
 * `runTurn` activity (`createGatewayRunTurn`) with the shipped receipt store
 * resolution and a counting executor, and logs every attempt and every executor
 * invocation to `EVENT_LOG`.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Context as ActivityContext } from "@temporalio/activity";
import type { AgentId, WorkspaceId } from "../../../../src/core/ids.js";
import { ExecutionBroker } from "../../../../src/execution/broker.js";
import { createGatewayRunTurn, type RungFactory } from "../../src/gateway-run-turn.js";
import { runTemporalWorker } from "../../src/worker.js";

const taskQueue = process.env.TASK_QUEUE;
const eventLog = process.env.EVENT_LOG;
const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
if (!taskQueue || !eventLog) throw new Error("TASK_QUEUE and EVENT_LOG are required");

const chatReply = (toolCalls: unknown[]) => new Response(
  JSON.stringify({ model: "receipt-test", choices: [{ message: { role: "assistant", content: JSON.stringify({ tool_calls: toolCalls }) } }] }),
  { status: 200, headers: { "content-type": "application/json" } },
);

const rungFactory: RungFactory = (_config, input, runtimeState) => ({
  isolated: true,
  ...(runtimeState ? { runtimeState } : {}),
  executeEffect: (effect, minFidelity) => {
    const executor = {
      id: "counting-executor",
      fidelity: 0,
      async canExecute() { return true; },
      async execute() {
        appendFileSync(eventLog, `${JSON.stringify({ event: "execute", id: effect.id, attempt: ActivityContext.current().info.attempt })}\n`);
        if (effect.id.endsWith(":1")) throw new Error("transient executor failure");
        return { ok: true };
      },
    };
    return new ExecutionBroker([executor], runtimeState).execute(
      effect,
      { agentId: input.agentId as AgentId, workspaceId: `temporal:${input.agentId}` as WorkspaceId },
      minFidelity,
    );
  },
});

const base = createGatewayRunTurn({
  baseUrl: "http://gw.test",
  model: "receipt-test",
  fetchImpl: (async () => chatReply([
    { name: "write_file", arguments: { path: "a.txt", content: "a" } },
    { name: "write_file", arguments: { path: "b.txt", content: "b" } },
  ])) as unknown as typeof fetch,
  rungFactory,
});

const activities = {
  async runTurn(input: Parameters<typeof base>[0]) {
    const info = ActivityContext.current().info;
    const seed = ((info.heartbeatDetails as { synthEffectReceipts?: Array<{ id: string; status: string }> } | undefined)?.synthEffectReceipts ?? [])
      .map((record) => `${record.id}:${record.status}`);
    appendFileSync(eventLog, `${JSON.stringify({ event: "attempt", attempt: info.attempt, seed })}\n`);
    return base(input);
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
