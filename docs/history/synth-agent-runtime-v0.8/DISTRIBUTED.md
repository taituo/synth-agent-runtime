# Distributed control plane

This document defines the v0.8 multi-replica contracts.

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

Events are append-only and sequence-addressable. `readEvents({afterSeq})` is the resumable protocol. `pruneEvents(throughSeq)` is an explicit operator action; v0.8 does not yet coordinate retention automatically across multiple durable event consumers.

## PostgreSQL schema

Install both files in order:

```bash
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/001_runtime.sql
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/002_distributed_control_plane.sql
```

Or use `installPostgresSchema()` from `src/postgres/schema.ts`.
