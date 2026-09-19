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


## v0.8 correlation fields

Distributed traces should carry tenant, logical resource ID, lease owner, fencing token, command/effect ID, project revision, mailbox sequence, and event sequence. These make stale-writer and replay incidents diagnosable.

## Temporal

The optional `integrations/temporal` package has its own correlation model in `src/correlation.ts` (`agentId`, `workflowId`, `activityType`, `attempt`, `retryReason`, ...), intentionally using the same field names as this document rather than a second scheme. `runTemporalWorker()` installs interceptors by default that attach these fields to every worker/workflow log line and emit a trace span per activity attempt to an optional `SynthTraceSink` (same shape as `TraceEvent`/`TraceSink` above — pass this runtime's own `InMemoryTraceSink`/`JsonlTraceSink` directly). See `docs/TEMPORAL.md` for details and a live verification script.
