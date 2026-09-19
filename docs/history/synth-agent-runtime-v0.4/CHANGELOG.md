# Changelog

## 0.4.0

- Added `RuntimeStateStore` for workspace checkpoints, command receipts, turn records and effect receipts.
- Added in-memory and crash-safe single-process JSON-file runtime-state implementations.
- Added `AgentRuntime.recover()` with workspace reconstruction and rollback of interrupted `started` turns.
- Added idempotent mailbox delivery by stable message ID and `AgentRuntime.command()` for retry-safe logical commands.
- Added `DurableTurn` and `runDurableTransactionalTurn()` with buffered output/tool events, effect replay modes and semantic-exposure barriers.
- Added durable `ExecutionBroker` effect receipts keyed by `Effect.id`; uncertain in-flight effects fail closed instead of auto-replaying.
- Added session-affine gateway routing via `x-synth-session` / `x-opencode-session`, Retry-After cooldowns and affinity eviction on unhealthy routes.
- Added persistent native `git cat-file --batch` blob hydration and per-blob hydration limits.
- Added optional Kubernetes `verifyReset()` and destroy-on-verification-failure in the warm pool.
- Added trace primitives (`Trace`, `TraceSink`, JSONL/in-memory sinks).
- Added recovery and durable-transaction demos.
- Added `RECOVERY.md`, `HARDENING.md`, `OBSERVABILITY.md` and refreshed architecture/inference/Kubernetes documentation.
- Expanded root tests to 20 passing tests, including process-style recovery, interrupted-turn rollback, durable effect deduplication, Git batch reads and warm-pool reset verification.

## 0.3.0

- Added canonical `ProjectSpec`/decision/task/artifact world store and context projections.
- Added atomic `JsonFileWorldStore` as a durable single-process reference implementation.
- Added `Supervisor` delegation, fan-out and reviewer graph operations.
- Added workspace `restore()`, `WorkspaceTransaction` and `runTransactionalTurn()` rollback/fallback primitive.
- Added gateway `ProfileRouterBackend` with logical model aliases, cooldown and fallback.
- Added generic `HttpGatewayBackend` for OpenAI-compatible upstreams.
- Added optional OpenCode stack → HTTP Chat Completions adapter without extra system-prompt injection.
- Added current Pi `AgentHarness`/lane runtime bridge source.
- Added optional Temporal workflow/client/worker integration package.
- Added effect allowlist/approval gate.
- Promoted the original long design spec to `SPEC.md` and bundled earlier Markdown artifacts under `docs/history/`.

## 0.2.0

- Added Kubernetes resource classes, gVisor Pod/NetworkPolicy generation, kubectl backend, warm pool, workspace sync-back and ProjectCell.

## 0.1.0

- Initial AgentRuntime, task/relation/artifact model, RAM workspace, native shallow/partial/sparse Git source, synthetic execution boundary and inference gateway shell.
