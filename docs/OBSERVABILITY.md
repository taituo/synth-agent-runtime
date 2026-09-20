# Observability

Every run is observable end to end: one OpenTelemetry trace from the client
through the workflow, activity, the shared `GatewayAgentEngine`, the execution
rung and the sandbox pod; native Temporal metrics; and correlated structured
logs. The runtime links against the OpenTelemetry **API** only (no exporter),
so an application that registers a provider gets the spans for free.

Live proof: `integrations/temporal/observability-live.ts` (registered as
`observability` in `scripts/live-proofs.mjs`; needs Temporal + the gVisor
cluster). It asserts the search-attribute query, the metric series, the span
chain and a correlated log line.

## Search attributes

The runtime knows these attributes (`SYNTH_SEARCH_ATTRIBUTES` in
`integrations/temporal/src/contracts.ts`):

| name | type | set from |
|---|---|---|
| `agentId` | Keyword | the workflow (always, when enabled) |
| `runId` | Keyword | the workflow's own run id |
| `taskSlug` | Keyword | caller |
| `rung` | Keyword | caller (`synthetic` / `sandbox`) |
| `isolation` | Keyword | caller (`unisolated` / `gvisor`) |
| `provider` | Keyword | caller |
| `model` | Keyword | caller |
| `outcome` | Keyword | the workflow, at the end |

Register them on a namespace once:

```bash
temporal operator search-attribute create --name agentId --type Keyword \
  --name runId --type Keyword --name taskSlug --type Keyword --name rung --type Keyword \
  --name isolation --type Keyword --name provider --type Keyword --name model --type Keyword \
  --name outcome --type Keyword
```

They are opt-in: set `DurableAgentState.searchAttributes` and
`durableAgentWorkflow` upserts them (plus `agentId`/`runId` at the start and
`outcome` when it finishes). Callers that omit the field set no attributes, so
a namespace that has not registered them is unaffected. Query a run:

```ts
const { executions } = await client.connection.workflowService.listWorkflowExecutions({
  namespace, query: "agentId = 'agt_123'",
});
// values live under execution.searchAttributes.indexedFields
```

## Metrics

Configure the native Prometheus exporter once, before any Temporal Core call:

```ts
Runtime.install({
  telemetryOptions: { metrics: { prometheus: { bindAddress: "127.0.0.1:9464", countersTotalSuffix: true, unitSuffix: true } } },
});
```

`/metrics` then serves the SDK's workflow/activity counters and histograms
(`temporal_workflow_*`, `temporal_activity_*`, latency, retry counts), plus the
runtime's custom series (`integrations/temporal/src/metrics.ts`):

| metric | what |
|---|---|
| `synth_model_calls_total` | model calls per turn body run |
| `synth_model_latency_milliseconds` | model call latency |
| `synth_effect_latency_milliseconds` | execution-rung effect latency, tagged `kind`/`executor` |
| `synth_activity_retries_total` | Temporal activity retries (attempt > 1) |

For OTLP instead of Prometheus use `telemetryOptions.metrics.otel = { url }`
(see the SDK `RuntimeOptions`); the series are the same.

## Tracing

```ts
import { OpenTelemetryPlugin } from "@temporalio/interceptors-opentelemetry";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()); // spans nest across awaits
const resource = new Resource({ "service.name": "synth" });
const provider = new BasicTracerProvider({ resource });
provider.addSpanProcessor(new SimpleSpanProcessor(exporter)); // OTLP/Batch in production
provider.register();

const otel = new OpenTelemetryPlugin({ resource, spanProcessor: new SimpleSpanProcessor(exporter) });
new Client({ connection, plugins: [otel] });                 // client -> workflow propagation
await createTemporalWorker({ ..., plugins: [otel] });        // workflow + activity interceptors
```

The plugin spans the client start, the workflow and the activity. The runtime
adds the inner spans (`src/observability/otel.ts`, no-op without a provider):

```text
StartWorkflow:durableAgentWorkflow
└─ StartActivity:runTurn
   └─ RunWorkflow:durableAgentWorkflow            (workflow side)
      └─ RunActivity:runTurn
         └─ synth.engine.run                       (GatewayAgentEngine)
            ├─ synth.model.request                 (the one model HTTP call)
            └─ synth.effect.execute                (ExecutionBroker)
               └─ synth.sandbox.exec | writeFile | readFile   (KubectlSandboxBackend → the pod)
```

`withSpan` resolves the tracer per call, so the runtime can be loaded before the
application registers its provider.

## Logs

The worker installs interceptors by default (`createSynthActivityInterceptors`,
`workflow-interceptors.ts`). Every activity log line carries the correlation
fields — `agentId`, `workflowId`, `runId`, `taskQueue`, `activityId`,
`activityType`, `attempt`, `retryReason`, `messageKind`, `rung` — and workflow
lifecycle lines (`synth.workflow.execute.start|end|error`, `synth.workflow.signal`,
`synth.workflow.outcome`) carry `workflowId`/`runId`/`agentId`. The `runTurn`
activity emits `synth.turn.start` with the rung. A sample correlated line:

```json
{"message":"synth.turn.start","meta":{"workflowId":"agent/agt_1","runId":"01a0…","activityId":"1","agentId":"agt_1","rung":"sandbox","attempt":1}}
```

## The proof asserts

- `listWorkflowExecutions({ query: "agentId = '…'" })` returns the run, and
  `agentId` / `rung` / `outcome` decode to the expected values;
- the Prometheus scrape contains the native workflow/activity series and every
  custom series;
- the exported span chain is
  `synth.sandbox.* → synth.effect.execute → synth.engine.run →
  RunActivity:runTurn → StartActivity:runTurn → RunWorkflow → StartWorkflow`,
  verified by parent span id;
- a log line carries workflowId/runId/activityId/agentId/rung.

Run it: `node scripts/live-proofs.mjs --only=observability`.
