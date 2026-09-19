# Chaos and failure testing

v0.6 keeps deterministic in-process failpoints and adds a real OS process-death contract.

## Deterministic failpoints

`ChaosController` can inject failure around durability, runtime state, executors, and gateway backends, for example:

```ts
new ChaosController([{ point: "executor.execute.after", nth: 1 }]);
```

## Real SIGKILL contract

`test/process-crash.test.ts` starts `test/fixtures/process-crash-worker.ts` as a child process. The worker:

1. persists an agent and workspace checkpoint;
2. enters a `DurableTurn` persisted as `started`;
3. mutates the in-memory workspace;
4. announces readiness;
5. is killed with `SIGKILL` by the parent.

The parent opens fresh persistence/runtime objects and calls `AgentRuntime.recover()`. The contract requires the turn to become `rolled_back`, the agent to recover from `thinking` to `idle`, and the dirty file to be absent.

This specifically tests loss of the entire JS heap and call stack, not just an exception path.

## Real Pod kill

`integrations/kubernetes/kill-chaos.ts` is the corresponding external contract for Kubernetes. It requires a real cluster and is documented in `LIVE-CONTRACTS.md`.
