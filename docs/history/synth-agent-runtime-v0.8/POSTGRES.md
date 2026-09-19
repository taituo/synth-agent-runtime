# PostgreSQL persistence

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

The v0.8 lease SQL currently accepts millisecond timestamps from the calling process. Production multi-node deployments should move lease expiry comparisons to the database clock or enforce sufficiently tight clock synchronization. This is a documented hardening item, not hidden by the local test suite.

Route-health writes are currently last-write-wins JSON records. Under very high concurrent failure traffic, exact success/failure counters can lose increments even though routing remains conservative enough for this reference implementation. Atomic counter/CAS updates are a future improvement.
