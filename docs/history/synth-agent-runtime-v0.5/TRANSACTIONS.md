# Transactional turns

v0.4 introduces a stronger transaction boundary than the earlier workspace-only rollback.

## DurableTurn

A turn begins by durably recording the exact `MemoryWorkspace` snapshot.

During an attempt:

- workspace writes remain in the RAM overlay;
- assistant output is buffered;
- tool presentation events are buffered;
- effects can be attempt-local, commit-staged, or barriers.

On success, commit-staged effects run first. Only after they succeed are buffered tool events and assistant output published.

On retryable failure before semantic exposure, the workspace returns to the starting snapshot and all buffered output disappears.

## Effect modes

```text
attempt-local
  synthetic filesystem operations
  isolated process execution
  other operations whose attempt environment can be discarded/reset

commit
  durable workflow dispatch
  other externally visible operations that can wait until the turn is accepted

barrier
  human approval
  any immediate operation whose result must be consumed now and cannot be transparently repeated
```

A barrier marks the turn as semantically exposed. Provider failover after that point must not silently replay the attempt.

## Important limit

A transaction cannot reverse an arbitrary external side effect. The system handles that with one of four techniques:

1. keep the effect attempt-local inside a disposable sandbox;
2. delay it until commit;
3. use an idempotency key/receipt;
4. stop transparent retry and require reconciliation.

The combination of `DurableTurn` + durable `ExecutionBroker` receipts is the v0.4 reference pattern.
