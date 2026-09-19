# Roadmap after v0.7

v0.7 intentionally spent its budget on live-proof automation and a backward correctness review. v0.8 should be driven by the unresolved P1 findings in `CODE-REVIEW.md`, not by adding another agent abstraction.

## v0.8 — shared-state correctness

1. Add revision/CAS or append-only mutation operations to the canonical project world so concurrent Super agents cannot overwrite each other.
2. Replace mailbox replay with durable message sequence + consumer cursor/ack semantics.
3. Add command ownership/lease/heartbeat and an explicit reconciliation state; never reclaim arbitrary `started` commands solely by timeout.
4. Add a generic `EffectReconciler` and concrete adapters for queryable external effects.
5. Move Responses continuation context into a shared/durable TTL store.
6. Make router affinity/health/cooldown consistent across gateway replicas.
7. Add event pagination/cursors/retention rather than unbounded `listEvents()`.
8. Add gateway tenant authentication, profile/model ACLs, concurrency/rate quotas and audit identity propagation.

## v0.8 production hardening

- enforce digest-pinned executor images in production mode;
- use scoped secret references/broker rather than plaintext service env for privileged ProjectCells;
- add shared immutable Git object cache, explicit LFS/submodule policy and hydration metrics;
- generate and commit a dependency lockfile in a networked build environment, then use `npm ci`;
- add SBOM/provenance if distributing built executor images;
- run Temporal server/worker kill + replay tests using the same command/effect identities.

## Live quality gate

A release candidate should repeatedly survive:

```text
control-plane SIGKILL
provider 429/5xx/drop
client disconnect
Postgres contention
Pi worker restart
Kubernetes executor Pod force-delete
warm-pool reuse/reset
Temporal worker SIGKILL
```

For every case, the accepted outcomes are only:

1. automatic recovery from a durable boundary; or
2. an explicit fail-closed/reconciliation-required state.

Silent duplicate external effects, silent workspace loss, and ambiguous “success” are release blockers.
