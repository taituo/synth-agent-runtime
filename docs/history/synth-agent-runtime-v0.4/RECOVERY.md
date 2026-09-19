# Runtime recovery

v0.4 separates three kinds of durable state:

```text
DurabilityProvider
  agent/task/relation/event state

RuntimeStateStore
  workspace checkpoints
  command receipts
  turn records
  effect receipts

WorldStore
  canonical project/spec/task/artifact state
```

`AgentRuntime.recover()` reconstructs live agent objects from durable `AgentSnapshot`s using caller-provided factories because an arbitrary JavaScript engine instance cannot be serialized safely.

```ts
await runtime.recover({
  definition: (definitionId, snapshot) => definitions.get(definitionId)!,
  engine: (definition, snapshot) => makePiEngine(definition, snapshot),
  workspace: (snapshot) => makeWorkspaceFor(snapshot),
})
```

If an agent was in a live execution state such as `thinking` when the process stopped, the prototype normalizes it to `idle` by default and records `recoveredFromState` in metadata. The caller then starts a fresh engine turn from the durable mailbox/world rather than attempting to resume an arbitrary JS stack.

## Interrupted turns

A `DurableTurn` writes its pre-attempt workspace snapshot before work begins. If recovery finds a turn still marked `started`, it restores that snapshot and marks the turn `rolled_back`.

This gives a deterministic rule:

```text
started but not committed = never became canonical
```

## Command idempotency

`AgentRuntime.command(commandId, fn)` is intended for RPC and workflow retries. A committed command returns its stored result. A command still marked `started` is not executed again automatically because the old process may have progressed past an external boundary.

Command results should therefore be serializable when using a persistent `RuntimeStateStore`.

## Effect idempotency

`ExecutionBroker` applies the same principle to `Effect.id`.

```text
no receipt       -> execute
committed        -> return stored result
started          -> EFFECT_OUTCOME_UNCERTAIN
failed           -> caller decides whether/how to retry
```

The uncertain state is intentional. Repeating a deploy/send/payment-style effect after a crash can be worse than requiring explicit reconciliation.

## Production store

`JsonFileRuntimeStateStore` is a single-process reference implementation, not a multi-node database. A production control plane should implement `RuntimeStateStore` on a transactional database and use row/version locking for commands, effects and turns.
