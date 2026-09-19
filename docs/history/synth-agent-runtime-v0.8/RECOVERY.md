# Recovery and reconciliation

Recovery has three distinct cases. They must not be collapsed into one generic retry policy.

## 1. Pre-exposure interrupted turn

If a durable turn is still `started` and `semanticExposed=false`, recovery restores its pre-turn workspace snapshot and marks it rolled back.

## 2. Post-exposure interrupted turn

If `semanticExposed=true`, recovery marks the turn failed/reconciliation-required. It does not call the interruption a transparent rollback.

## 3. Abandoned distributed command/effect

A stale `started` command requires `CommandCoordinator.reconcile()`. A stale effect requires an effect-specific `EffectReconciler` probe. Neither primitive interprets timeout alone as permission to repeat an external side effect.

## Process death evidence

`test/process-crash.test.ts` uses a real child process and `SIGKILL`, then reopens durable state in a new process/runtime. This contract passed for this artifact.

## Agent run leases

`LeasedAgentRunner` adds renewable ownership around a logical run and cancels the runtime if renewal is lost. This is a meaningful concurrency boundary, but the current code review still calls for atomically checking the fencing generation on every durable agent-state mutation in a fully adversarial multi-replica deployment.
