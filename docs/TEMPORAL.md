# Temporal deployment

The root runtime intentionally does not depend on the Temporal SDK. The optional package in `integrations/temporal/` contains a real workflow, signals/query, client and worker bootstrap.

The workflow owns durable logical state such as status and mailbox. Network/filesystem/model operations remain activities because Temporal workflows must stay deterministic.

The prototype exposes `sendMessage`, `cancelAgent` and `getAgentState`. `runTurn` is an activity contract that a deployment binds to its Pi/runtime worker.

Long-lived agents should use Continue-As-New when workflow history reaches an operational threshold.

## Workflow sandbox constraints

Temporal workflow code runs in a restricted V8 isolate, not a full Node/browser global scope: notably, the global `structuredClone` is not available there (it is available in ordinary Node worker/activity code). `durableAgentWorkflow` uses a sandbox-safe JSON round-trip clone (`clone()` in `src/correlation.ts`) instead. Anything imported into workflow code — including interceptor modules bundled via `workflowInterceptorModules` — must stay within this restricted API surface.

The mailbox is consumed with an explicit per-turn count, not cleared wholesale: `runTurn` receives a snapshot of the mailbox, and only the messages present at snapshot time are removed afterward (`state.mailbox.splice(0, consumedCount)`). A message a signal appends while the activity is still in flight survives and is processed on the next loop iteration, rather than being silently discarded. (An earlier version cleared the whole mailbox unconditionally on the idle transition; that could drop a message that should have ended the loop, leaving the workflow waiting forever.) For a durable multi-consumer deployment, a persisted cursor/idempotency key is still the production shape this compact example approximates.

## Failure semantics: park vs. fail

A turn failure is classified before the workflow decides what to do:

- **Permanent** (`ApplicationFailure.nonRetryable`; the gateway activity marks HTTP 400/401/403/404/422 this way) ends the agent immediately: `status = "failed"`, exactly one activity call, cause in `lastError`.
- **Transient** (HTTP 408/409/425/429/5xx, timeouts, network errors, empty or malformed completions) is first retried by Temporal's activity retry policy (`maximumAttempts: 3`). If retries are exhausted the agent **parks** instead of dying: `status = "waiting"`, the failed turn's messages stay in the mailbox, and `lastError` holds the root cause. It waits with exponential backoff (default 5s initial, x2, capped at 5 min; override per agent with the optional `parkBackoff` on the initial state) and retries the same turn. A successful turn clears `lastError`, resets the backoff, and resumes normal flow.

Parking is cancellation-aware (`condition(() => cancelled, backoffMs)`), so `cancelAgent` on a parked agent takes effect promptly rather than waiting out the backoff. New messages arriving while parked do **not** cut the wait short — the provider is presumably still down — they queue and are processed after it. An agent that parks and retries forever grows workflow history, so a production deployment should Continue-As-New at a history threshold (out of scope here).

## Observability: correlation and interceptors

`src/worker.ts`'s `runTemporalWorker()` installs Synth's own interceptors by default: `activity-interceptors.ts` (worker-side; attaches `agentId`/`workflowId`/`activityType`/`attempt`/`retryReason` to every activity log line and metric, and emits one trace span per attempt to an optional `SynthTraceSink`) and `workflow-interceptors.ts` (bundled into the workflow isolate; attaches the same correlation fields to `workflow.log` lines and emits `synth.workflow.execute.*`/`synth.workflow.signal` lifecycle lines). Field names in `src/correlation.ts` mirror `docs/OBSERVABILITY.md`'s correlation model rather than inventing a second naming scheme. Pass `interceptors: { trace, maxAttempts, traceIdFor }` to `runTemporalWorker()` to wire in a trace sink; pass `workflowInterceptorModules: []` to disable the workflow-side interceptor.

`integrations/temporal/interceptors-live.ts` is a live proof against a real Temporal dev server (`temporal server start-dev`): it runs a happy-path and a flaky-then-succeeds workflow and asserts the trace sink and worker logs both carry the expected correlation fields, retry reason, and `willRetry`.

## v0.8 activity/redelivery rule

Temporal/RPC redelivery of commands should enter `CommandCoordinator` with a stable command ID. A `started` record from a dead worker requires reconciliation; timeout alone is not permission to replay an external action.
