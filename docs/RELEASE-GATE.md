# Release Gate

The release question is no longer "can a stale replica overwrite the current agent?" (closed — see `HARDENING.md`) but "have we proven the whole stack under real infrastructure and operational load?"

## Closed correctness gates

- Agent-state writes carry a fencing generation under `LeasedAgentRunner`.
- PostgreSQL atomically validates owner, token, and lease expiry on fenced agent writes.
- Lower fencing generations cannot overwrite a higher stored agent generation.
- Unfenced PostgreSQL updates cannot overwrite an agent after fenced ownership has begun.
- PostgreSQL lease acquire/renew/validate uses the PostgreSQL clock.
- `CommandCoordinator` validates its lease authoritatively before terminal commit.
- Durable command reconciliation, project CAS, mailbox ACK, effect reconciliation, continuation isolation, route affinity, SIGKILL recovery, Responses contracts, and sandbox contracts from v0.8 remain intact.

## Required before 1.0 RC

```text
[x] live PostgreSQL concurrency: no SKIP
[x] DB-clock skew scenario on real PostgreSQL
[x] hard agent takeover scenario on real PostgreSQL
[x] pinned Pi checkout E2E: no SKIP
[x] disposable Kubernetes + gVisor Pod-kill test: no SKIP
[x] external gateway/provider probe: no SKIP (incl. abort-survival,
    continuation, tool calls, concurrency — see docs/history for the
    full live-matrix run)
[x] cross-replica race coverage for duplicate spawn and duplicate mailbox
    steer (two replicas sharing one durability provider)
[~] sustained race/load, not just a bounded repro — proven for the
    distributed-state/durability layer directly (32-256 concurrent
    workers against real PostgreSQL, 15-45s soaks, 100/100+ contention
    rounds, 0 errors; see CHANGELOG). Still open: running this against
    >= 2 actual control-plane/gateway service replicas under sustained
    traffic, not just many client connections against one durable store.
[ ] rolling schema/application upgrade test
[ ] soak test with forced worker/provider/pod restarts — the sustained
    load above did not include chaos (killed workers/pods) mid-soak
[~] production IAM + shared rate limiting + durable audit — shared
    rate limiting is closed (`SharedTenantRateLimitPolicy` +
    `PostgresRateLimitStore`, atomic per-tenant/window upsert, verified live
    against PostgreSQL). A real identity provider and a durable audit sink
    are still open.
[x] durable named event-consumer ACK + safe retention watermark — the event
    log now has a named-consumer ACK registry (`ackEvent`/`getEventCursor`/
    `listEventCursors`/`forgetEventConsumer`) and `safeEventWatermark`/
    `pruneEventsSafe`, which prune only up to the slowest registered consumer
    (0 when none is registered, so an unconfigured deployment fails closed).
    The raw `pruneEvents(throughSeq)` remains available and caller-owned.
[x] task/artifact per-record revision/CAS or equivalent ownership rule —
    `compareAndSwapTask`/`compareAndSwapArtifact` mirror `compareAndSwapProject`
[ ] continuation size, encryption, retention, and cleanup policy
```

## Interpretation

A green local/unit suite is necessary but not sufficient for `1.0`. A release candidate should require the live matrix to run against actual PostgreSQL and Kubernetes infrastructure and should record the exact Pi revision/provider path used by the test.

The unchecked items above, plus the "Known issues carried into this RC"
section in `CHANGELOG.md`, are the actual gap between `1.0.0-rc.1` and a
`1.0.0` GA tag. None of them are known-exploitable correctness or security
bugs (unlike the git ref/remote argument-injection issue fixed in this RC);
they are missing coverage/hardening for the fully-loaded production
deployment shape.
