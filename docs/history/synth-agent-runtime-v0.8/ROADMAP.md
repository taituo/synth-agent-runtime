# Roadmap after v0.8

v0.8 closes the largest cooperative multi-replica gaps from the v0.7 review. The next release should avoid adding new agent abstractions and concentrate on proving the remaining distributed invariants.

## v0.9 priorities

1. **Hard agent-state fencing.** Atomically validate the current agent lease/fencing token on every persistence mutation that can be produced by a stale runner. Do not rely solely on cooperative cancellation.
2. **Database-clock leases.** Move PostgreSQL lease expiry/renew comparisons to the database clock or formally define a clock-skew budget.
3. **Durable event-consumer cursors.** Store named event ACK cursors and coordinate retention so one slow consumer cannot silently lose required history.
4. **Mailbox compaction.** Remove the legacy snapshot-mailbox growth path once migration compatibility is no longer needed.
5. **World granularity.** Add revisions/CAS or event sourcing for task and artifact bodies, not only `ProjectSpec`.
6. **Distributed gateway security.** External identity, hashed/API-key storage, shared rate limiter/quota, durable audit log, and tenant-aware retention.
7. **Atomic router health.** Avoid lost concurrent route-health counter updates; add expiry/cleanup for shared router state.
8. **Continuation operations.** Size limits, encryption-at-rest policy, compression/blob strategy, and cleanup jobs.
9. **Live CI promotion.** Make PostgreSQL, Pi, Kubernetes/gVisor, and provider-gateway live contracts mandatory in an environment that actually supplies them.

The quality gate for v0.9 should be two or more control-plane replicas intentionally racing while stale writers are delayed past lease expiry, with the durable state proving that only the valid fencing generation can commit.
