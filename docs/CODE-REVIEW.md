# Backward code review — v0.1 → v0.9

> **Runtime consolidation (2026-09-20).** Temporal is the single durable engine
> and the shared `GatewayAgentEngine` is the one turn body. The homegrown
> `AgentRuntime`, `DurableTurn`/`transactional-turn`, `TemporalDurabilityProvider`,
> `EffectReconciler`, `AgentRunner`/`LeasedAgentRunner`, `CommandCoordinator`,
> `EffectPolicy` and orchestration `Supervisor` were deleted (`CHANGELOG.md`,
> Unreleased). References below to those APIs are historical. The Postgres stores
> (leases/fencing, effect receipts, mailbox cursors, world revisions) remain; see
> the root `README.md` and `docs/KNOWN-OPEN.md` for the current shape.

> **Status: point-in-time review.** This review was written against v0.9 and
> distinguishes closed correctness problems from remaining
> production-hardening work as of that point. Later audit passes (see
> `docs/SECOND-REVIEW.md`) and the `v1.0.0-rc.1` live-infrastructure runs
> closed several of the items this review lists as remaining. For current
> release status, the authoritative source is `docs/RELEASE-GATE.md`.

This review follows the failure boundaries backward from the current runtime and distinguishes closed correctness problems from remaining production-hardening work.

## P1 findings closed by v0.9

### Stale agent owner could overwrite a newer owner

**Closed for durable `AgentSnapshot` state writes.** `LeasedAgentRunner` passes the active fencing generation into `AgentRuntime.run()`. PostgreSQL persists the state only if the matching lease row still has the same resource, owner, fencing token, and an unexpired DB-clock lease. `synth_agents.fencing_token` also prevents generation regression.

A stale worker that wakes after takeover receives `AGENT_FENCE_REJECTED`; it does not publish a false durable completed/failed terminal state.

### PostgreSQL lease expiry depended on worker wall clocks

**Closed.** Acquire, renew, release, and `validateLease()` use PostgreSQL `clock_timestamp()`. Worker-supplied `now` remains only for deterministic local/in-memory implementations and is ignored by `PostgresDistributedControlStore`.

### Abandoned command had no ownership/reconciliation protocol

**Closed in v0.8 and strengthened in v0.9.** `CommandCoordinator` holds a renewable fencing lease, requires explicit reconciliation for abandoned `started` commands, and now uses authoritative `LeaseStore.validateLease()` before terminal commit instead of comparing database timestamps with `Date.now()`.

### Concurrent project writers could blindly overwrite each other

**Closed for `ProjectSpec`.** In-memory, JSON-file, and PostgreSQL world stores support revision CAS and reject stale/equal blind writes.

### Mailbox delivery lived only inside mutable agent snapshots

**Closed for the distributed mailbox path.** `MailboxStore` provides idempotent append, sequence reads, named ACK cursors, retry after failed runs, and ACK clamping. `AgentRuntime.send()` does not race a fenced agent-state writer when a dedicated mailbox store is configured.

### Uncertain external effects had no reconciliation seam

**Closed.** `EffectReconciler` observes external state without blindly replaying an uncertain side effect.

### Continuation/router state was process-local

**Closed at the shared-store layer.** Continuations, route health/cooldown, and tenant-scoped affinity can use `PostgresDistributedControlStore`.

## v0.9 review notes and fixes

- Fenced agent writes are atomic with lease validation in PostgreSQL.
- Legacy/unfenced PostgreSQL writes cannot update an agent after fencing begins.
- Local and JSON durability keep monotonic explicit fence generations for deterministic tests while remaining single-writer friendly.
- `AgentRuntime.#setState()` rolls its in-memory state back if durable persistence rejects the fence.
- A fence rejection bypasses normal failed/completed publication so a stale owner does not create a false terminal event.
- `LeaseStore.validateLease()` removes the cross-machine `Date.now()` comparison from command terminal commit.
- Fresh schema installs and upgrades both include `synth_agents.fencing_token`.
- The live Postgres scenario now includes deliberate ±extreme worker-clock skew and a two-generation stale-agent takeover.

## Remaining P1 / release-candidate gates

### Production gateway identity, shared quotas, and durable audit

The gateway has authentication/ACL/rate-policy seams, but bundled implementations are reference-grade. A public multi-tenant release still needs a production identity provider, distributed quota/rate limiting, scoped secret policy, and durable audit records.

### Live infrastructure matrix

At the time this review was written, the build environment did not provide live PostgreSQL, a Pi checkout, a gVisor Kubernetes cluster, or external provider credentials, so those tests were correctly reported as `SKIP`, not PASS. This gap is now closed: `v1.0.0-rc.1` was independently verified with real PostgreSQL concurrency/fencing, a real pinned Pi checkout E2E, a real Kubernetes + gVisor pod-kill, and a full external-provider matrix all live and passing — see `README.md`'s "Tests executed for this artifact" section and `docs/RELEASE-GATE.md`. A bare CI/sandbox run without the relevant environment variables/credentials still correctly reports `SKIP` for these checks (see `docs/LIVE-PROOF.md`); that is expected behavior, not a regression.

## Remaining P2

### Durable runtime output/tool events are not themselves lease-fenced records

Terminal agent state is hard-fenced. Streaming output/tool events are still an event stream rather than a lease-generation CAS object. The runner aborts the local runtime on lease loss, and durable-turn buffering exists for semantic transactional work, but a stricter design could attach generation metadata to every agent event or gate publication through an authoritative event append.

### Event retention has no durable named-consumer watermark registry

**Closed.** The event log now has a durable named-consumer ACK registry on
`DurabilityProvider` (`ackEvent`, `getEventCursor`, `listEventCursors`,
`forgetEventConsumer`; backed by `synth_event_cursors` in PostgreSQL and
mirrored in the in-memory/JSON-file stores). `safeEventWatermark()` returns
the minimum ack across registered consumers, and `pruneEventsSafe()` prunes
only through it; with no registered consumer the watermark is 0 and nothing is
pruned, so an unconfigured deployment fails closed. Acks are monotonic and
clamped to the current max sequence. The raw `pruneEvents(throughSeq)` is
unchanged and remains the caller-owned primitive for deployments that manage
the bound themselves.

### Task/artifact records are last-write-wins

`ProjectSpec` membership/decisions are protected by revision CAS, but individual task/artifact bodies are not yet revisioned.

### Route-health telemetry updates are last-write-wins

Cooldown behavior is usable, but exact concurrent counters can lose updates without atomic field operations/CAS.

### Continuation operational policy is incomplete

TTL exists. Production still needs body-size limits, encryption/retention policy, cleanup scheduling, and possibly compressed/blob-backed storage for large continuation state.

### Physical execution can cross external side-effect boundaries

A physical `process.exec` with network access or credentials may change external systems. Filesystem rollback does not make those effects replay-safe; they still need explicit effect identity/policy/reconciliation.

## Current assessment

v0.9 closed the two distributed correctness gaps that most directly blocked an internal release candidate: stale agent-state overwrite and process-clock lease ownership. Live infrastructure proof has since been completed for `v1.0.0-rc.1` (see `docs/RELEASE-GATE.md`); the remaining path to GA `1.0.0` is multi-tenant security, operational policy, and soak/upgrade testing, not another large runtime rewrite.
