# Recovery and reconciliation

> **Runtime consolidation (2026-09-20).** Temporal is the single durable engine
> and the shared `GatewayAgentEngine` is the one turn body. The homegrown
> `AgentRuntime`, `DurableTurn`/`transactional-turn`, `TemporalDurabilityProvider`,
> `EffectReconciler`, `AgentRunner`/`LeasedAgentRunner`, `CommandCoordinator`,
> `EffectPolicy` and orchestration `Supervisor` were deleted (`CHANGELOG.md`,
> Unreleased). References below to those APIs are historical. The Postgres stores
> (leases/fencing, effect receipts, mailbox cursors, world revisions) remain; see
> the root `README.md` and `docs/KNOWN-OPEN.md` for the current shape.

## Recovery ownership

Recovery of a durable agent state in a distributed PostgreSQL deployment must occur under a current agent lease when it needs to mutate an already-fenced `AgentSnapshot`. `AgentRecoveryOptions.fence` can supply that ownership proof. Unfenced local/JSON recovery remains available for explicitly single-writer deployments.

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

`LeasedAgentRunner` adds renewable ownership around a logical run and cancels the runtime if renewal is lost. The fencing generation it carries is checked atomically against `synth_leases` on every durable agent-state mutation in PostgreSQL (`putAgentFenced()`), not only cooperatively in the runtime; a stale generation is rejected with `AGENT_FENCE_REJECTED` rather than silently applied. See `docs/ARCHITECTURE.md` and `docs/HARDENING.md` for the full fencing model.
