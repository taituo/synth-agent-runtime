# Upgrade notes: v0.3 → v0.4

v0.4 is source-compatible with the v0.3 constructor/API paths used by the included demos and tests. New durability features are opt-in.

## AgentRuntime

Existing code still works:

```ts
const runtime = new AgentRuntime(durability, broker)
```

To enable crash checkpoints and idempotency receipts, pass a `RuntimeStateStore` as the fourth constructor argument:

```ts
const runtimeState = new JsonFileRuntimeStateStore("./state/runtime.json")
const runtime = new AgentRuntime(durability, broker, new Map(), runtimeState)
```

At process startup, call `recover()` before accepting commands.

## ExecutionBroker

Existing code:

```ts
new ExecutionBroker(executors)
```

Durable effect receipts:

```ts
new ExecutionBroker(executors, runtimeState)
```

Reuse the same `Effect.id` only when the operation is logically the same operation. To intentionally retry a failed operation as a new action, issue a new effect ID.

## Transactional turns

`runTransactionalTurn()` remains available for the original workspace-only behavior.

Use `runDurableTransactionalTurn()` when output/effect commit semantics and crash turn records are required.

## NativeGitSource

No call-site change is required. Blob reads now use a persistent `git cat-file --batch` process. Optional `maxBlobBytes` defaults to 32 MiB.

## Kubernetes warm pool

`SandboxBackend.verifyReset()` is optional. Existing backends remain compatible. When implemented and it returns `false`, the pool destroys that sandbox instead of reusing it.
