# Changelog

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
- Added supervisor and transaction demos plus v0.3 unit tests.
- Promoted the original long design spec to `SPEC.md`.
- Bundled every earlier Markdown artifact under `docs/history/` and added a Markdown manifest.

## 0.2.0

- Added first-class execution policies and Kubernetes resource classes.
- Added hardened gVisor Pod and NetworkPolicy generation.
- Added concrete kubectl-based sandbox backend.
- Added bounded warm Pod pool with reset-before-reuse.
- Added sparse trusted workspace materialization and source-change sync-back.
- Added Kubernetes `process.exec` executor.
- Added ProjectCell manager for executor + service groups.
- Added executor container Dockerfile and gVisor/bootstrap manifests.
- Connected `AgentEngineContext.executeEffect()` to `ExecutionBroker`.
- Added Kubernetes tests and demo.

## 0.1.0

- Initial AgentRuntime, task/relation/artifact model.
- RAM workspace + native shallow/partial/sparse Git source.
- Synthetic execution boundary, durability boundary and inference gateway shell.
- Bundled Pi synthetic Git and OpenCode Go stack router prototypes.
