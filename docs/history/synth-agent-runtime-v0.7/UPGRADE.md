# Upgrade: v0.6 → v0.7

v0.7 is source-compatible for the main prototype APIs, but several failure semantics are intentionally stricter.

## Durable turns

Attempt-local effects (`workspace.*`, `process.exec`) now receive a turn-scoped executor ID. Code that inspects durable effect receipts should treat the scoped ID as an implementation idempotency key rather than the human/logical effect ID.

Barrier and staged commit effects persist semantic exposure before execution. After a process crash, an exposed started turn is recovered as `failed` and requires reconciliation; it is no longer reported as a transparent rollback.

## Warm sandbox pool

`stats()` includes waiting callers. Closing the pool rejects queued acquirers. A sandbox created for a direct caller is no longer eligible to satisfy another waiter before that caller receives its lease.

## Gateway

The Node gateway defaults to a 16 MiB request body ceiling. Configure `maxRequestBytes` if a trusted workload legitimately needs larger requests. Abort/cancellation now propagates deeper into router/upstream/model streams.

## Responses

Reasoning-summary and incomplete events are emitted where applicable. Consumers that assumed every successful stream ended only with `response.completed` should accept `response.incomplete` as a terminal state.

The bundled continuation cache remains process-local; no migration is required, but multi-replica deployments should not depend on `previous_response_id` affinity until v0.8/shared storage is implemented.

## Verification

Run:

```bash
npm run live:proof
```

External Postgres/Pi/Kubernetes/gateway checks only execute when their environment variables are configured; skipped checks remain visible in the summary.
