# Responses transport

v0.8 keeps the v0.7 coding-agent-oriented Responses transport and makes continuation state shareable between gateway replicas.

Supported contract coverage includes:

- text output and streaming deltas
- function-call items and argument deltas
- reasoning-summary event families
- usage accounting fields used by the adapter
- incomplete terminal details
- nested message/content input extraction
- request cancellation propagation
- `previous_response_id` continuation through `ContinuationStore`

Continuation records have TTL and tenant ownership. A record written for tenant A is not readable by tenant B or anonymously.

The OpenCode HTTP adapter accepts an injected continuation store; without one it uses the local in-memory implementation for single-process development.

This is a compatibility surface, not a promise to emulate every future field of every upstream Responses implementation. Contract tests live in `test/responses.test.ts`.

## Client disconnect is a safe, handled case

A client disconnecting mid-stream (a `ReadableStream.cancel()` while the upstream provider is still emitting events) must never crash the gateway process. The streaming adapter tracks stream liveness explicitly and stops writing to a stream's controller once it has been torn down, so a disconnect races safely against in-flight upstream events instead of throwing from an already-closed/errored controller. Upstream abort propagation is teardown-safe in the same way: aborting the upstream request on disconnect never attempts a further write to a controller that has already been marked dead. This is covered by a dedicated regression test (`integrations/opencode-http-gateway/test/abort.test.ts`).
