# Backward code review — v0.1 → v0.8

This review follows the failure boundaries backward from v0.8 into the older runtime. It distinguishes what is now fixed from what still needs production hardening.

## Findings closed in v0.8

### P1 — abandoned command had no ownership/reconciliation protocol

**Closed.** `CommandCoordinator` wraps a command in an expiring lease, persists owner + fencing token, verifies ownership before terminal commit, and requires explicit reconciliation for an abandoned `started` receipt. A reconciliation result is stamped with the currently held fencing generation.

### P1 — concurrent project writers could overwrite each other

**Closed for `ProjectSpec`.** Projects now have revision CAS in memory, JSON-file, and PostgreSQL stores. Equal/stale blind puts are rejected.

### P1 — mailbox delivery was only embedded in mutable agent snapshots

**Closed for the new mailbox path.** `MailboxStore` provides idempotent append, sequence reads, named ACK cursors, retry after failed runs, and ACK clamping. The legacy snapshot mailbox remains for compatibility and is now a cleanup/scalability concern rather than the durable delivery mechanism.

### P1 — uncertain effect had no generic reconciliation seam

**Closed.** `EffectReconciler` lets effect-specific probes observe the external world without re-executing the effect.

### P1 — `previous_response_id` and router stickiness were process-local

**Closed at the interface/store level.** Continuations and router health/affinity can be shared through `PostgresDistributedControlStore`; tenant isolation is part of continuation and affinity semantics.

### P1 — gateway had no tenant authorization boundary

**Partially closed.** Gateway authentication, model ACL, identity propagation, and a rate-policy seam now exist. The bundled authenticator and limiter are reference implementations; production identity, shared quotas, and durable audit remain open.

### P2 — event consumers needed full replay

**Partially closed.** Durability providers support ordered reads after a sequence and explicit pruning. Durable named event-consumer ACK state is not yet implemented.

## v0.8 review fixes made during this pass

- PostgreSQL lease release preserves fencing history instead of deleting the lease row.
- command-state stores reject lower fencing generations and committed→nonterminal regression.
- command reconciliation publishes under the current owner/fencing token rather than retaining a dead owner's generation.
- mailbox ACK cannot advance past an existing message sequence.
- tenant continuations require an exact tenant match, including rejecting anonymous reads of tenant-owned records.
- sticky route affinity is tenant scoped even when two tenants use the same session ID.
- project blind writes require a strictly newer revision once the project exists.

## Remaining P1

### Hard fencing is not yet applied to every agent mutation

`LeasedAgentRunner` provides one active cooperative owner and aborts on renewal loss. However, `AgentRuntime`/`DurabilityProvider.putAgent()` does not yet require the current fencing token on every state write. A stalled/non-cooperative stale worker could theoretically wake after lease loss and race a newer owner. v0.9 should make the persistence layer reject such writes atomically.

### PostgreSQL lease time uses process timestamps

The shared lease rows are correct under reasonably synchronized clocks, but expiry decisions use milliseconds supplied by a caller. A production design should use the PostgreSQL clock for acquire/renew/validity or formally enforce clock-skew limits.

## Remaining P2

### Route-health updates are last-write-wins

Two gateway replicas updating the same health JSON can lose exact counter increments. Cooldown routing is still usable, but atomic updates/CAS would make telemetry and decisions stronger.

### Event retention has no durable consumer registry

`afterSeq` is resumable, but the system cannot yet compute a safe global prune point from named consumer ACKs.

### Legacy agent snapshot mailbox can grow

The separate mailbox is the durable path, but snapshots still contain the historical compatibility mailbox. It should be migrated/compacted away.

### Task/artifact bodies are not individually revisioned

Project CAS protects project membership and decisions. Concurrent edits to a task/artifact record still use last-write-wins storage semantics.

### Gateway security is reference-grade

Static in-memory bearer tokens and an in-memory fixed-window limiter are not a production IAM/quota system. There is no durable audit sink yet.

### Continuation operational policy is incomplete

TTL exists, but production needs body-size limits, encryption/retention policy, cleanup scheduling, and potentially blob/compression storage for large contexts.

### Physical execution can cross external boundaries

A physical `process.exec` with network/credentials can perform effects outside the workspace. Automatic replay safety cannot be inferred merely because filesystem changes are transactional. Such workloads need explicit effect identities/policies or network isolation.

## Current assessment

v0.8 is substantially stronger as a distributed reference implementation than v0.7: the project, command, mailbox, continuation, and router control planes now have explicit multi-replica primitives. The main correctness gap is no longer “who owns this command?”; it is **enforcing the agent fencing generation at every stale-write boundary**. That should be the next release's first change.
