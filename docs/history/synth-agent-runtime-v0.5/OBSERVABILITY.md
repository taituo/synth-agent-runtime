# Observability

v0.4 adds a small transport-neutral trace abstraction in `src/observability/trace.ts`.

`TraceSink` receives events containing:

```text
traceId
spanId
parentSpanId
name
phase = start | event | end | error
timestamp
attributes
```

Reference sinks:

- `InMemoryTraceSink` for tests;
- `JsonlTraceSink` for simple local capture.

The next adapter should map these records to OpenTelemetry rather than inventing another telemetry backend.

Recommended production correlation fields:

```text
project_id
agent_id
task_id
turn_id
attempt_id
workspace_id
provider
account/route
model
request_id
effect_id
executor
sandbox_id
artifact_id
token counts
latency/cost
```

A useful invariant is that a user-visible agent answer can be traced backwards to the exact inference route, tool/effect sequence, workspace revision and promoted artifact.
