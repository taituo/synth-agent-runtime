# Roadmap: RC to GA

`v1.0.0-rc.1` closes the distributed correctness/security gaps found across two independent audit passes: hard agent-state fencing, PostgreSQL database-clock lease semantics, atomic agent-identity creation, cross-replica mailbox double-steer, a gateway abort-crash, and a git ref/remote argument-injection issue. It has also been verified against real infrastructure: PostgreSQL concurrency/fencing, a pinned Pi checkout E2E, Kubernetes + gVisor pod-kill, and a live external provider matrix (see `docs/RELEASE-GATE.md` and `CHANGELOG.md`).

The next milestone is not another broad runtime abstraction layer. It is a GA hardening program driven by the unchecked items in `docs/RELEASE-GATE.md`:

## Path to `1.0.0` GA

1. **Sustained multi-replica soak/load testing.** Keep two or more control-plane replicas racing under *sustained* load, not just a bounded repro, including forced worker/provider/pod restarts.
2. **Rolling schema/application upgrade testing.** Prove a rolling upgrade of schema and application code against a live deployment without correctness loss.
3. **Distributed rate limiting.** Replace the current per-process `InMemoryTenantRateLimitPolicy` with a shared, distributed quota/rate-limit implementation so a tenant's effective limit does not scale with replica count.
4. **Per-record task/artifact CAS.** Extend revision/compare-and-swap ownership rules to individual task/artifact records, which are currently last-write-wins bodies (project membership/decisions already have CAS).
5. **Continuation retention/encryption policy.** Add size limits, encryption/retention policy, and cleanup scheduling for Responses continuation state; TTL already exists.
6. **Production IAM + durable audit.** A real identity provider, scoped secret handling, and a durable audit sink to replace the reference `StaticBearerAuthenticator`.
7. **Safe event-retention watermark.** Wire the durable event log's `pruneEvents(throughSeq)` to mailbox named-consumer ACK cursors so `throughSeq` is computed from consumers' actual read positions instead of being caller-supplied — see `docs/CODE-REVIEW.md`.

## Release criterion

`1.0.0` GA should ship only when the remaining unchecked items in `docs/RELEASE-GATE.md` are closed and the live infrastructure matrix continues to run green in CI/staging, not just once during the RC audit.
