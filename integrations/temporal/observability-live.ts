/**
 * Live proof: one trace, metrics and correlated logs for an agent run.
 *
 * A real `durableAgentWorkflow` turn runs through the shared
 * `GatewayAgentEngine` and the execution rung. The proof asserts the
 * discriminating quantities, not a status:
 *
 *   - search attributes: a `workflowService.listWorkflowExecutions` query
 *     filtered by `agentId` returns the run, and the attribute value decodes;
 *   - metrics: the worker's Prometheus endpoint serves the SDK's native
 *     workflow/activity series and the runtime's custom model/effect series;
 *   - tracing: the exported spans form one chain
 *     `StartWorkflow -> RunWorkflow -> RunActivity:runTurn -> synth.engine.run
 *      -> synth.model.request / synth.effect.execute -> synth.sandbox.*`;
 *   - logs: a log line carries workflowId/runId/activityId/agentId/rung.
 *
 * Uses the repo's digest-pinned executor image (set SYNTH_EXECUTOR_IMAGE, or
 * SYNTH_LIVE_GVISOR=1 to default to the pinned image) so the effect spans reach
 * the sandbox pod. Skips (exit 2) without the cluster.
 *
 *   SYNTH_LIVE_GVISOR=1 SYNTH_EXECUTOR_IMAGE=ghcr.io/...@sha256:... \
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx observability-live.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { Client, Connection } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { OpenTelemetryPlugin } from "@temporalio/interceptors-opentelemetry";
import { Resource } from "@opentelemetry/resources";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { DefaultLogger, Runtime, type LogEntry } from "@temporalio/worker";
import { EXECUTOR_IMAGE } from "../../src/execution/executor-image.js";
import { SYNTH_SEARCH_ATTRIBUTES, type DurableAgentState } from "./src/contracts.js";
import { closeSandboxRungs, createGatewayRunTurn } from "./src/gateway-run-turn.js";
import { cancelAgent, durableAgentWorkflow, getAgentState } from "./src/workflows.js";
import { createTemporalWorker } from "./src/worker.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-observability-${Date.now()}`;
const metricsPort = Number(process.env.OBS_METRICS_PORT ?? 9464);
const image = process.env.SYNTH_EXECUTOR_IMAGE ?? EXECUTOR_IMAGE;

function skip(reason: string): never {
  console.error(JSON.stringify({ skipped: true, reason }));
  process.exit(2);
}
if (process.env.SYNTH_LIVE_GVISOR !== "1" && !process.env.SYNTH_EXECUTOR_IMAGE) {
  skip("set SYNTH_LIVE_GVISOR=1 and SYNTH_EXECUTOR_IMAGE (a digest-pinned node+git image) to run the sandbox trace");
}

// 1. Logs + Prometheus metrics from the native SDK runtime. Must be installed
//    before any other Temporal Core call.
const logs: LogEntry[] = [];
Runtime.install({
  logger: new DefaultLogger("INFO", (entry: LogEntry) => logs.push(entry)),
  telemetryOptions: {
    metrics: { prometheus: { bindAddress: `127.0.0.1:${metricsPort}`, countersTotalSuffix: true, unitSuffix: true } },
  },
});

// 2. Tracing: one provider, an in-memory exporter the proof can read. The
//    AsyncLocalStorage context manager is what makes spans nest across awaits;
//    register it globally so every API copy (runtime + interceptors) shares it.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const exporter = new InMemorySpanExporter();
const resource = new Resource({ "service.name": "synth-observability-proof" });
const provider = new BasicTracerProvider({ resource });
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();
const otelPlugin = new OpenTelemetryPlugin({ resource, spanProcessor: new SimpleSpanProcessor(exporter) });

const INDEXED_VALUE_TYPE: Record<string, number> = { Text: 1, Keyword: 2, Int: 3, Double: 4, Bool: 5, Datetime: 6 };

async function ensureSearchAttributes(connection: Connection): Promise<void> {
  const searchAttributes: Record<string, number> = {};
  for (const entry of SYNTH_SEARCH_ATTRIBUTES) searchAttributes[entry.name] = INDEXED_VALUE_TYPE[entry.type]!;
  try {
    await connection.operatorService.addSearchAttributes({ namespace, searchAttributes: searchAttributes as never });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists|already registered|AlreadyExists/i.test(message)) throw error;
  }
}

const chatReply = (toolCalls: unknown[]) => new Response(
  JSON.stringify({ model: "otel-model", choices: [{ message: { role: "assistant", content: JSON.stringify({ tool_calls: toolCalls }) } }] }),
  { status: 200, headers: { "content-type": "application/json" } },
);

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const activities = {
  runTurn: createGatewayRunTurn({
    baseUrl: "http://gw.test",
    model: "otel-model",
    fetchImpl: (async () => chatReply([
      { name: "write_file", arguments: { path: "otel.txt", content: "hello from the pod" } },
      { name: "run_cmd", arguments: {} },
    ])) as unknown as typeof fetch,
  }),
};

const worker = await createTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./src/workflows.ts", import.meta.url)),
  workflowInterceptorModules: [fileURLToPath(new URL("./src/workflow-interceptors.ts", import.meta.url))],
  activities,
  taskQueue,
  address,
  namespace,
  plugins: [otelPlugin],
});
void worker.run();

const connection = await Connection.connect({ address });
await ensureSearchAttributes(connection);
const client = new Client({ connection, namespace, plugins: [otelPlugin] });

const agentId = `agt_otel_${Date.now()}`;
const workflowId = `agent/${agentId}`;
const handle = await client.workflow.start(durableAgentWorkflow, {
  taskQueue,
  workflowId,
  args: [{
    agentId,
    status: "idle",
    updatedAt: Date.now(),
    mailbox: [{ id: "m1", role: "human", text: "write a file and run a command", createdAt: Date.now() }],
    turnConfig: {
      systemPrompt: "You edit files.",
      tools: [
        { name: "write_file", effect: "workspace.write" },
        { name: "run_cmd", effect: "process.exec", command: "echo otel" },
      ],
      rung: { kind: "sandbox", image },
    },
    searchAttributes: { taskSlug: "otel-proof", rung: "sandbox", isolation: "gvisor", provider: "fake", model: "otel-model" },
  } as DurableAgentState],
});

// The turn is done when the activity recorded its result and the workflow is
// back to idle/waiting for more messages.
const turnState = await waitFor(
  async () => {
    const state = (await handle.query(getAgentState)) as DurableAgentState;
    return state.lastResult !== undefined && state.status !== "running" ? state : undefined;
  },
  180_000,
  "the turn to complete",
);

// Finish the workflow so the workflow/client spans are exported and the final
// `outcome` search attribute is set.
await handle.signal(cancelAgent);
await handle.result();

// The workflow span is exported by a sink shortly after the workflow closes.
const spans = await waitFor(async () => {
  const finished = exporter.getFinishedSpans();
  return finished.some((span) => span.name.startsWith("RunWorkflow:")) ? finished : undefined;
}, 20_000, "the workflow span to export");

const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
const parentOf = (span: ReadableSpan | undefined): ReadableSpan | undefined =>
  span?.parentSpanId ? byId.get(span.parentSpanId) : undefined;
const find = (needle: string): ReadableSpan | undefined => spans.find((span) => span.name.includes(needle));
const isEffect = (span: ReadableSpan | undefined): boolean => span?.name === "synth.effect.execute";

const clientSpan = find("StartWorkflow:");
const workflowSpan = find("RunWorkflow:");
const startActivitySpan = find("StartActivity:runTurn");
const activitySpan = find("RunActivity:runTurn");
const engineSpan = find("synth.engine.run");
const modelSpan = find("synth.model.request");
const effectSpan = find("synth.effect.execute");
const sandboxSpan = find("synth.sandbox.exec") ?? find("synth.sandbox.writeFile") ?? find("synth.sandbox.readFile");

const chain: string[] = [];
for (let cursor: ReadableSpan | undefined = sandboxSpan; cursor && chain.length < 12; cursor = parentOf(cursor)) chain.push(cursor.name);
const sandboxEffect = parentOf(sandboxSpan);
const parentChainOk =
  Boolean(clientSpan && workflowSpan && startActivitySpan && activitySpan && engineSpan && modelSpan && effectSpan && sandboxSpan)
  && isEffect(sandboxEffect)
  && parentOf(sandboxEffect) === engineSpan
  && parentOf(engineSpan) === activitySpan
  && parentOf(modelSpan) === engineSpan
  && parentOf(effectSpan) === engineSpan
  && parentOf(activitySpan) === startActivitySpan
  && parentOf(startActivitySpan) === workflowSpan
  && parentOf(workflowSpan) === clientSpan;
const traceOk = parentChainOk;

// Search attributes: the agentId filter returns the run and the value decodes.
const executions = await waitFor(async () => {
  const response = await connection.workflowService.listWorkflowExecutions({ namespace, query: `agentId = '${agentId}'` });
  const match = (response.executions ?? []).find((execution) => execution.execution?.workflowId === workflowId);
  return match ? response.executions ?? [] : undefined;
}, 30_000, "the workflow to appear in the agentId query");
const first = executions.find((execution) => execution.execution?.workflowId === workflowId);
const attributeOf = (name: string): unknown => {
  // Temporal returns the attributes nested under `searchAttributes.indexedFields`.
  const indexed = (first?.searchAttributes as { indexedFields?: Record<string, unknown> } | undefined)?.indexedFields;
  const payload = indexed?.[name];
  if (!payload) return undefined;
  try {
    return defaultPayloadConverter.fromPayload(payload);
  } catch {
    return undefined;
  }
};
const attributeAgentId = attributeOf("agentId");
const attributeRung = attributeOf("rung");
const attributeOutcome = attributeOf("outcome");

// Metrics: scrape the worker's Prometheus endpoint.
const metricsText = await waitFor(async () => {
  const response = await fetch(`http://127.0.0.1:${metricsPort}/metrics`).catch(() => undefined);
  if (!response?.ok) return undefined;
  const text = await response.text();
  return text.includes("synth_model_calls") ? text : undefined;
}, 20_000, "the custom metric series to appear");
const metricSeries = {
  workflow: /^temporal_workflow_/m.test(metricsText) || metricsText.includes("temporal_workflow_"),
  activity: metricsText.includes("temporal_activity_"),
  modelCalls: metricsText.includes("synth_model_calls"),
  modelLatency: metricsText.includes("synth_model_latency"),
  effectLatency: metricsText.includes("synth_effect_latency"),
};

// Logs: a correlated line with the ids and the rung.
const correlated = logs.find((entry) => {
  const meta = entry.meta ?? {};
  return entry.message.includes("synth.turn.start")
    && typeof meta.workflowId === "string"
    && typeof meta.runId === "string"
    && typeof meta.activityId === "string"
    && typeof meta.agentId === "string"
    && typeof meta.rung === "string";
});

const ok = traceOk
  && attributeAgentId === agentId
  && attributeRung === "sandbox"
  && attributeOutcome === "cancelled"
  && metricSeries.workflow
  && metricSeries.activity
  && metricSeries.modelCalls
  && metricSeries.modelLatency
  && metricSeries.effectLatency
  && correlated !== undefined;

console.log(JSON.stringify({
  address,
  workflowId,
  turn: { status: turnState.status, observations: (turnState.lastResult as { observations?: unknown[] } | undefined)?.observations?.length ?? null },
  searchAttributes: { agentId: attributeAgentId, rung: attributeRung, outcome: attributeOutcome },
  metrics: metricSeries,
  spanChain: chain,
  spans: [...new Set(spans.map((span) => span.name))].sort(),
  spanEdges: spans.map((span) => `${span.name} <- ${(span.parentSpanId && byId.get(span.parentSpanId)?.name) ?? span.parentSpanId ?? "none"}`),
  rawSearchAttributeKeys: Object.keys(((first?.searchAttributes as { indexedFields?: object } | undefined)?.indexedFields ?? {}) as object),
  parentChainOk,
  correlatedLog: correlated ? { message: correlated.message, meta: correlated.meta } : null,
  ok,
}, null, 2));

provider.shutdown();
worker.shutdown();
// A persistent sandbox rung outlives a turn by design; destroy the cached pod
// so the proof does not leak one per run.
await closeSandboxRungs().catch(() => undefined);
await connection.close().catch(() => undefined);
process.exit(ok ? 0 : 1);
