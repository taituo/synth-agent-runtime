# PostgreSQL persistence

## v0.9 fencing and database-clock leases

`deploy/postgres/003_release_hardening.sql` adds `synth_agents.fencing_token bigint NOT NULL DEFAULT 0`. Fresh schema installation includes the same column.

Fenced agent writes join the current `synth_leases` row and accept the update only when resource, owner, token, and expiry match. Lease acquire/renew/release/validation calculate epoch milliseconds from PostgreSQL `clock_timestamp()`. The optional caller `now` argument is intentionally ignored by the PostgreSQL implementation.

The live concurrency scenario also passes absurd past/future worker timestamps to prove they do not affect lease ownership, then performs a two-generation agent takeover and verifies that the stale generation cannot publish.

v0.8 has two cooperating PostgreSQL adapters:

- `PostgresPersistence` — agents, tasks, relations, runtime events, commands, checkpoints, turns, effects, projects, artifacts
- `PostgresDistributedControlStore` — leases/fencing, mailbox cursors, Responses continuations, route health and affinity

## Schema

```bash
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/001_runtime.sql
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/002_distributed_control_plane.sql
```

The Node integration in `integrations/postgres/node-pg.ts` exposes both adapters over a `pg` pool.

## Contention proof

With `SYNTH_POSTGRES_URL` set:

```bash
node integrations/postgres/concurrency.ts
```

The scenario creates multiple independent connections and requires exactly one concurrent winner for:

- command claim
- effect claim
- lease acquisition
- project compare-and-swap

This artifact environment did not provide PostgreSQL, so the live scenario is packaged but reported as SKIP in `TEST-RESULTS.txt`.

## Important operational caveats

v0.9 closes the former clock-skew gap: PostgreSQL lease acquire, renew, release, and validity checks derive time from `clock_timestamp()`. Caller timestamps are ignored by the PostgreSQL lease implementation.

Route-health writes are currently last-write-wins JSON records. Under very high concurrent failure traffic, exact success/failure counters can lose increments even though routing remains conservative enough for this reference implementation. Atomic counter/CAS updates are a future improvement.
