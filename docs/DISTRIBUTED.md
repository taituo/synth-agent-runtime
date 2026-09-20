# Distributed control plane

> **Runtime consolidation (2026-09-20).** Temporal is the single durable engine
> and the shared `GatewayAgentEngine` is the one turn body. The homegrown
> `AgentRuntime`, `DurableTurn`/`transactional-turn`, `TemporalDurabilityProvider`,
> `EffectReconciler`, `AgentRunner`/`LeasedAgentRunner`, `CommandCoordinator`,
> `EffectPolicy` and orchestration `Supervisor` were deleted (`CHANGELOG.md`,
> Unreleased). References below to those APIs are historical. The Postgres stores
> (leases/fencing, effect receipts, mailbox cursors, world revisions) remain; see
> the root `README.md` and `docs/KNOWN-OPEN.md` for the current shape.

## v0.9: hard agent fencing

The cooperative v0.8 agent lease is now enforced at the durable write boundary. A control-plane replica may continue executing after it has become stale, but its durable agent-state write is rejected unless its lease resource, owner ID, fencing token, and DB-time expiry all still match.

`LeaseStore.validateLease()` is the authoritative validity primitive. PostgreSQL implements it with the database clock; in-memory mode keeps an injectable deterministic clock for tests.

This document defines the v0.9 multi-replica contracts.

## Agent identity contract

`DurabilityProvider.createAgent(snapshot): Promise<boolean>` is the atomic agent-identity-creation boundary, not a read-then-write preflight check. Every implementer makes the winning insertion atomic: `LocalMemory` and the JSON-file provider perform the existence check and insert inside their own serialization boundary, PostgreSQL uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, and the Temporal adapter passes the call through to its underlying store. `AgentRuntime.spawn()` treats a `false` (non-insertion) result as `AGENT_ALREADY_EXISTS`, so two concurrent `spawn()` calls for the same agent ID — whether on one runtime or on two runtimes sharing one durability provider — can never both succeed. This closes a race where a `listAgents()`-based existence preflight could let both calls observe absence before either persisted.

## Lease contract

A lease is `{resourceId, ownerId, fencingToken, expiresAt}`. The token is monotonic for the lifetime of the resource key. Expiration permits a new owner; it does not make an old owner trustworthy again.

`withRenewingLease()` renews before TTL expiry and aborts a supplied signal if renewal fails. Code running under that signal still needs to cooperate with cancellation.

PostgreSQL release deliberately expires the row instead of deleting it so the next claim increments the previous fence.

## Command contract

`CommandCoordinator` is the safe path for a command that may be redelivered by RPC/Temporal or another control-plane replica:

```text
acquire command:<id> lease
       │
       ▼
read durable receipt
  ├ committed → return saved result
  ├ started   → require reconcile()
  └ missing/failed
       │
       ▼
persist started(owner,fence)
       │
       ▼
run(signal,fence)
       │
verify lease still current
       │
       ├ lost → uncertain/reconciliation required
       └ held → persist committed
```

An abandoned `started` receipt is never automatically interpreted as safe to execute again.

## Effect reconciliation

Effects are different from commands because the external world may already have changed. A reconciliation probe asks the external system about the specific effect identity and returns one of:

- committed — persist the observed result
- failed — persist a known failure
- pending — remain `started`
- unknown — remain `started`

Unknown does not mean retry.

## Mailbox contract

Each agent message has a durable message ID and an ordered sequence. Appending the same message ID is idempotent. Consumers own named ACK cursors.

An ACK beyond the currently existing mailbox is clamped rather than creating a skip over future messages.

`MailboxStore.appendMailbox(agentId, message): Promise<{ envelope, inserted }>` reports whether this specific call performed the durable insertion. When two runtime replicas share one durable mailbox and race to append the same message ID, only the replica whose call actually inserted the row (`inserted: true`) steers the live `AgentEngine`; the other replica receives the already-committed envelope (`inserted: false`) and does not steer again. PostgreSQL implements this with `ON CONFLICT DO NOTHING`, reading back the committed existing envelope in a second statement on conflict. This is what prevents duplicate cross-replica steering — a race that a purely local re-check of one replica's own in-memory mailbox snapshot cannot catch, since each replica only sees its own snapshot.

## World CAS contract

`ProjectSpec.revision` is the compare-and-swap generation. CAS increments it. A stale writer receives the current project instead of overwriting it. `putProject()` is migration/import-oriented and accepts only a strictly newer revision once a project exists.

## Shared inference contract

A gateway replica must be disposable. Therefore continuation state, sticky affinity, and route cooldown state can be moved to `PostgresDistributedControlStore`.

Tenant boundaries are part of the key space:

```text
continuation: response id + tenant ownership
route affinity: tenant : virtual model : session
route health: virtual model : route
```

## Event contract

Events are append-only and sequence-addressable. `readEvents({afterSeq})` is the resumable protocol. `pruneEvents(throughSeq)` is an explicit operator action; v0.9 does not yet coordinate retention automatically across multiple durable event consumers.

## PostgreSQL schema

Install both files in order:

```bash
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/001_runtime.sql
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/002_distributed_control_plane.sql
```

Or use `installPostgresSchema()` from `src/postgres/schema.ts`.
