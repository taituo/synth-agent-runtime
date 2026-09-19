# Roadmap after v0.6

v0.6 establishes local process-death and Responses transport contracts. The next work should primarily be **live system validation and shared-state scaling**, not another abstraction rewrite.

## v0.7 candidate: live distributed proof

1. Run PostgreSQL contention in CI with real independent connections and repeated worker restarts.
2. Run Pi `MemoryExecutionEnv` E2E against a pinned Pi checkout in CI.
3. Run OpenCode Desktop/TUI against the gateway with a real configured provider stack and capture a protocol trace.
4. Run gVisor Kubernetes Pod-kill/reset contracts on a disposable cluster.
5. Move Responses continuation from process-local cache into a shared durable session store.
6. Add lease/heartbeat ownership for long-running task execution and worker disappearance.
7. Add effect reconciliation adapters for systems with queryable idempotency keys (deployments, jobs, messages).
8. Add Temporal server/worker kill tests using the same durable command/effect identities.

Quality gate: killing any one process, model route, or sandbox must either recover automatically or stop in an explicit fail-closed state without duplicate external effects.
