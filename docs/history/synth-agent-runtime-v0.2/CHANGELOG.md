# Changelog

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
