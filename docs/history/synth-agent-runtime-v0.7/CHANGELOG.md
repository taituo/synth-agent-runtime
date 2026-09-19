# Changelog

## 0.7.0

- Added a one-command `live:proof` harness plus CI workflows for core contracts, real PostgreSQL contention, pinned Pi E2E, and a manual/self-hosted gVisor Kubernetes kill contract.
- Expanded the root suite to 49 tests and the Responses contract to 6 tests.
- Fixed durable retry correctness by scoping attempt-local effect receipt IDs to the durable turn.
- Fixed the semantic-exposure crash window by durably persisting the retry barrier before irreversible/barrier/commit effects cross the external boundary.
- Recovery now marks interrupted semantically exposed turns failed/reconciliation-required instead of claiming transparent rollback.
- Fixed a Kubernetes warm-pool double-lease race, waiter-close hangs, and creation-failure waiter leaks.
- Made physical workspace sync-back atomic by restoring the pre-sync snapshot on any read/limit/apply failure.
- Stopped treating failed sandbox `git status` as an empty change set.
- Hardened the HTTP gateway with request-size limits, downstream backpressure, cancellation propagation, and upstream response cancellation before failover.
- Expanded Responses support with reasoning-summary events, incomplete terminal events/details, nested input parsing, stricter tool schemas, richer usage, and current-request instruction semantics for continuation.
- Improved native Git error handling and drained persistent `git cat-file --batch` stderr.
- Serialized durable-turn metadata writes so delayed `started` writes cannot overtake terminal records, and persisted semantic exposure before buffered output/tool publication.
- Serialized AgentRuntime output/tool event persistence before completion and isolated throwing event observers from durable execution.
- Changed logical command exceptions to fail closed/uncertain by default, with explicit `retrySafeOnError` opt-in for reclaimable failures.
- Namespaced route health by virtual model and stripped hop-by-hop headers from HTTP upstream requests.
- Added `CODE-REVIEW.md` and `LIVE-PROOF.md` with a retrospective v0.1→v0.7 audit and explicit remaining P1/P2 gaps.

## 0.6.0

- Added `JsonFileDurabilityProvider`, a crash-safe single-writer local persistence backend for agents/tasks/relations/events.
- Added a real child-process `SIGKILL` contract proving AgentRuntime reconstructs the agent, rolls back a persisted started turn, and restores its pre-turn workspace snapshot.
- Added Responses protocol helpers and event encoding for coding-agent text/function-call streams.
- Extended the bundled Pi/OpenCode stack gateway adapter to `/v1/responses`, including streaming tool argument deltas, usage, session affinity, bounded local `previous_response_id` continuation, and no gateway-injected system prompt.
- Hardened the Node HTTP gateway with client-disconnect cancellation and ephemeral-port discovery.
- Added a real HTTP gateway test for streamed Responses transport.
- Added an installable Pi `MemoryExecutionEnv` E2E contract using Pi's normal read/write/edit/bash tools against a RAM-only seeded workspace.
- Added live PostgreSQL multi-connection claim contention and Kubernetes forced-Pod-kill scripts for external environments.
- Added `RESPONSES.md` and `LIVE-CONTRACTS.md`; refreshed current architecture/recovery/inference/Postgres/Pi/Kubernetes docs.
- Expanded the root suite to 30 passing tests.

## 0.5.0

- Added driver-agnostic `PostgresPersistence` implementing `DurabilityProvider`, `RuntimeStateStore`, and `WorldStore`.
- Added deployable Postgres schema, Compose environment, and optional `node-postgres` adapter/smoke test.
- Added atomic `claimCommand()` and `claimEffect()` store capabilities and wired them into `AgentRuntime.command()` and `ExecutionBroker` for multi-process duplicate prevention.
- Hardened executor exceptions: effects that may have crossed an external boundary remain `started`/uncertain instead of being marked safely retryable.
- Added deterministic `ChaosController` failpoints plus durability, runtime-state, executor, and gateway wrappers.
- Added built-in crash-recovery scenario and a focused chaos test matrix.
- Added an installable Pi `AgentHarness` E2E contract test using Pi's real faux provider and normal execution tools.
- Added `POSTGRES.md`, `CHAOS.md`, and `PI-E2E.md`.
- Expanded the root test suite to 25 passing tests.

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
