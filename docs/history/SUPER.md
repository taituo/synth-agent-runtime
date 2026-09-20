# Supervisor orchestration

> **Runtime consolidation (2026-09-20).** Temporal is the single durable engine
> and the shared `GatewayAgentEngine` is the one turn body. The homegrown
> `AgentRuntime`, `DurableTurn`/`transactional-turn`, `TemporalDurabilityProvider`,
> `EffectReconciler`, `AgentRunner`/`LeasedAgentRunner`, `CommandCoordinator`,
> `EffectPolicy` and orchestration `Supervisor` were deleted (`CHANGELOG.md`,
> Unreleased); the in-memory/JSON durability stores, the world implementations
> and the chaos modules were quarantined to `docs/history/museum/`. References
> below to those APIs are historical. The root `README.md`, `docs/TEMPORAL.md`,
> `docs/HARNESS.md` and `docs/KNOWN-OPEN.md` describe the current shape.

`Supervisor` is a graph/orchestration helper above `AgentRuntime`; it is not a special LLM species.

`delegate()` creates a task, forks the supervisor's workspace, spawns a child and records `supervises` and `delegates_to` relations. `fanOut()` creates multiple workers. `assignReviewer()` creates a reviewer and records a `reviews` edge.

A child agent may itself become a supervisor because supervision is represented by relationships, not a fixed hierarchy class.


## v0.8 concurrent supervisors

Supervisor/project mutations should use project revision CAS. If multiple supervisors coordinate the same logical command or agent, use the distributed lease/fencing primitives rather than relying on one process.
