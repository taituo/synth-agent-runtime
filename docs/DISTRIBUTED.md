# Distributed stores

Temporal owns durable execution. PostgreSQL is the store for the state that is
genuinely store-shaped and shared across replicas: leases/fencing, effect
receipts, the mailbox, world revisions, and the inference gateway's shared
state. This document defines those store contracts. (The former homegrown
control plane is deleted and archived under `docs/history/`.)

## Agent identity contract

`DurabilityProvider.createAgent(snapshot): Promise<boolean>` is the atomic
agent-identity-creation boundary, not a read-then-write preflight. PostgreSQL
uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, so two concurrent
`createAgent()` calls for the same agent id cannot both succeed; the loser
receives `false` and treats it as `AGENT_ALREADY_EXISTS`. This closes a race
where a `listAgents()`-based preflight could let both calls observe absence
before either persisted.

## Lease and fencing contract

A lease is `{resourceId, ownerId, fencingToken, expiresAt}`. The token is
monotonic for the resource key. Expiration permits a new owner; it does not make
an old owner trustworthy again.

`LeaseStore.validateLease()` is the authoritative validity primitive; the
PostgreSQL implementation uses the database clock (`clock_timestamp()`), so
worker wall clocks never decide ownership. PostgreSQL release deliberately
expires the row instead of deleting it, so the next claim increments the
previous fence.

`PostgresPersistence.putAgentFenced(snapshot, fence)` validates owner, token and
DB-time expiry atomically against `synth_leases` before writing an agent row;
`synth_agents.fencing_token` prevents generation regression. A stale writer gets
`AGENT_FENCE_REJECTED`. The live 32-worker concurrency + fencing proof is
`integrations/postgres/concurrency.ts` (CI `postgres-live.yml`); the unit
contracts are in `test/postgres-control.test.ts`.

## Effect receipt contract

`ExecutionBroker` claims an effect by `effect.id` before running it:

```text
claim effect:<id> receipt
   ├ committed → return the saved result (replay)
   ├ started   → EFFECT_OUTCOME_UNCERTAIN (never a blind replay)
   └ missing/failed → run, then persist committed/failed
```

A receipt left `started` by a crash is uncertain until reconciliation; timeout
alone is not permission to repeat an external action. The shipped Temporal rung
stores receipts in Temporal activity state (`TemporalActivityStateStore`, in the
heartbeat details), so a retried activity dedupes a committed effect by
`effect.id` (`integrations/temporal/effect-receipt-live.ts`). `PostgresPersistence`
also implements `claimEffect`/`putEffect` and can be injected as the broker's
store; a resolved receipt cannot be regressed (covered by
`test/postgres.test.ts`).

## Mailbox contract

Each message has a durable id and an ordered sequence; appending the same id is
idempotent. `MailboxStore.appendMailbox(agentId, message)` returns
`{ envelope, inserted }`: only the replica whose call performed the insertion
steers; a replica that observes an already-inserted envelope does not steer
again. This prevents duplicate cross-replica steering. Consumers own named ACK
cursors; an ACK beyond the existing mailbox is clamped rather than skipping
future messages.

In the runtime path the workflow owns the mailbox
(`durableAgentWorkflow`); the Postgres `MailboxStore` is the shared store for
multi-replica consumers.

## World CAS contract

`ProjectSpec.revision` is the compare-and-swap generation. `compareAndSwapProject`
increments it and returns the current project to a stale writer instead of
overwriting. `compareAndSwapTask`/`compareAndSwapArtifact` mirror it.
`putProject()` is migration/import-oriented and accepts only a strictly newer
revision once a project exists.

## Shared inference contract

A gateway replica must be disposable, so continuation state, sticky affinity and
route cooldown state can be moved to `PostgresDistributedControlStore`. Tenant
boundaries are part of the key space:

```text
continuation: response id + tenant ownership
route affinity: tenant : virtual model : session
route health: virtual model : route
```

## Event contract

Events are append-only and sequence-addressable. `readEvents({afterSeq})` is the
resumable protocol. `safeEventWatermark()`/`pruneEventsSafe()` prune only up to
the slowest registered consumer (0 when none is registered, so an unconfigured
deployment fails closed); the raw `pruneEvents(throughSeq)` remains available and
caller-owned.

## PostgreSQL schema

Install both files in order:

```bash
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/001_runtime.sql
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/002_distributed_control_plane.sql
```

Or use `installPostgresSchema()` from `src/postgres/schema.ts`.
