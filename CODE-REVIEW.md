# Backward code review — v0.1 → v0.9

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

### Live infrastructure matrix is not proven in this artifact environment

The code paths exist, but this build environment did not provide live PostgreSQL, a Pi checkout, a gVisor Kubernetes cluster, or external provider credentials. Those tests are correctly reported as `SKIP`, not PASS. A release candidate should require them green in CI/staging.

## Remaining P2

### Durable runtime output/tool events are not themselves lease-fenced records

Terminal agent state is hard-fenced. Streaming output/tool events are still an event stream rather than a lease-generation CAS object. The runner aborts the local runtime on lease loss, and durable-turn buffering exists for semantic transactional work, but a stricter design could attach generation metadata to every agent event or gate publication through an authoritative event append.

### Event retention has no durable named-consumer watermark registry

`afterSeq` reads and pruning exist, but there is no global safe-prune calculation across named durable consumers.

### Task/artifact records are last-write-wins

`ProjectSpec` membership/decisions are protected by revision CAS, but individual task/artifact bodies are not yet revisioned.

### Route-health telemetry updates are last-write-wins

Cooldown behavior is usable, but exact concurrent counters can lose updates without atomic field operations/CAS.

### Continuation operational policy is incomplete

TTL exists. Production still needs body-size limits, encryption/retention policy, cleanup scheduling, and possibly compressed/blob-backed storage for large continuation state.

### Physical execution can cross external side-effect boundaries

A physical `process.exec` with network access or credentials may change external systems. Filesystem rollback does not make those effects replay-safe; they still need explicit effect identity/policy/reconciliation.

## Current assessment

v0.9 closes the two distributed correctness gaps that most directly blocked an internal release candidate: stale agent-state overwrite and process-clock lease ownership. The architecture is now at the point where the next milestone should be driven primarily by **live infrastructure proof, multi-tenant security, operational policy, and soak/upgrade testing**, not another large runtime rewrite.
