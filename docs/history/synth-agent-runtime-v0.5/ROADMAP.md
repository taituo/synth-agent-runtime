# Roadmap after v0.5

v0.5 adds the first credible multi-process persistence path plus deterministic failure injection. The next version should exercise these seams under real external systems rather than only expanding interfaces.

## v0.6 candidates

1. Run Postgres integration tests against a real database in CI, including concurrent command/effect claims and connection-loss recovery.
2. Run the bundled Pi E2E contract inside the pinned Pi monorepo and add a second E2E that swaps `NodeExecutionEnv` for `MemoryExecutionEnv`.
3. Add lossless `/v1/responses` translation with streamed tool-call deltas, reasoning metadata, usage, abort propagation, and session affinity.
4. Put durable-turn buffering directly around Pi harness output/tool events so provider replay and workspace rollback share one transaction boundary.
5. Add task leases/heartbeats and optimistic project updates on Postgres for horizontally scaled supervisors.
6. Run process-level chaos: terminate control-plane workers, Temporal workers, and sandbox Pods from external processes during active turns.
7. Add scoped secret broker/workload identity and egress-policy enforcement.
8. Add OpenTelemetry export and dashboards for route, turn, effect, workspace, and executor traces.
9. Add shared content-addressed Git cache, LFS/submodule policy, memory-pressure eviction, and dynamic sparse expansion.
10. Add Firecracker/Kata only after the above recovery and identity paths are exercised in production-like tests.

Quality gate: independent control-plane workers must be able to race, crash, and restart without corrupting canonical project state or duplicating external effects.
