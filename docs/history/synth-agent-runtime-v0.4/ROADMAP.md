# Roadmap after v0.4

v0.4 focuses on durability + transaction hardening. The next work should turn the reference seams into production adapters rather than adding another large conceptual layer.

## v0.5 candidates

1. Postgres-backed `RuntimeStateStore` + `WorldStore` with optimistic concurrency, task leases and heartbeat recovery.
2. Full Pi monorepo integration using the current `AgentHarness`/`ExecutionEnv` seam, including durable turn buffering around Pi output/tool events.
3. Lossless OpenAI Responses API gateway bridge with streamed tool-call deltas, reasoning metadata, usage, abort and session affinity.
4. Chaos harness: kill control plane mid-turn, kill Temporal worker, kill/reset Pod, inject provider 429/5xx/stream drop, interrupt Git hydration.
5. Shared content-addressed Git object cache, LFS/submodule policy, memory-pressure eviction and dynamic sparse expansion.
6. Scoped secret broker, workload identity and egress policy service.
7. Production Kubernetes policies: digest-pinned images, ResourceQuota/LimitRange, dedicated sandbox node pools and admission-policy tests.
8. Supervisor task leases, candidate artifacts, reviewer quorum and canonical artifact promotion.
9. OpenTelemetry adapter and runtime dashboards.
10. Firecracker/Kata executor only after the higher-level recovery/effect semantics are stable.

The key quality gate remains: processes, provider routes and disposable execution cells should be killable without corrupting the logical project state or silently duplicating external effects.
