# Roadmap after v0.9

v0.9 closes the two largest distributed correctness gaps left by v0.8: hard agent-state fencing and PostgreSQL database-clock lease semantics. The next milestone should not introduce another broad runtime abstraction layer. It should be a release-candidate program driven by live proof and operational hardening.

## Candidate path to `1.0.0-rc.1`

1. **Promote live PostgreSQL proof to mandatory.** Run the existing contention suite against a real PostgreSQL service in CI/staging and require the DB-clock skew and stale-agent generation tests to pass.
2. **Promote Pi E2E to mandatory.** Keep the Pi revision pinned for reproducibility, then add a separately tracked compatibility run against the chosen moving branch.
3. **Promote Kubernetes/gVisor destruction tests to mandatory.** Run active workload Pod kills, warm-pool reset verification, and workspace recovery against a disposable cluster.
4. **Production gateway security.** External identity/API keys, tenant-scoped secrets, shared quotas/rate limits, and durable audit.
5. **Durable event-consumer registry.** Named ACK cursors plus a safe global retention watermark.
6. **Per-record task/artifact concurrency.** Revision/CAS or equivalent ownership rules instead of last-write-wins bodies.
7. **Continuation operations.** Size limits, encryption/retention policy, cleanup jobs, and optional blob/compression storage.
8. **Multi-replica soak and rolling-upgrade proof.** Keep at least two control-plane replicas racing while killing/restarting workers, providers, and executor Pods.

## Release criterion

The next version should be called `1.0.0-rc.1` only when the live matrix in `RELEASE-GATE.md` is green without infrastructure SKIPs in the release environment. Until then, v0.9 remains the hardened internal-beta/developer-preview line.
