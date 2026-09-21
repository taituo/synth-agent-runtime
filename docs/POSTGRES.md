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

This exact scenario was run live against a real PostgreSQL instance for `v1.0.0-rc.1`: 16 concurrent workers, deliberate database-clock skew (absurd past/future worker timestamps that do not affect lease ownership), and a two-generation hard agent takeover where the stale generation cannot publish. See `README.md`'s "Tests executed for this artifact" section and `CHANGELOG.md` for the exact figures. In an environment without `SYNTH_POSTGRES_URL` set, the same scenario is still packaged and runnable, but `npm run live:proof` correctly reports it as SKIP rather than PASS.

## Scaling under real load

A benchmark/soak suite (up to 256 concurrent workers, 15-45s sustained soaks,
real PostgreSQL) was reported run against `v1.0.0-rc.1` in `CHANGELOG.md`.
Every contention-critical primitive was reported clean through 256-way
concurrency: atomic agent creation (exactly 1 winner), lease contention,
command claim, and project CAS all scored 100/100 or better across rounds with
0 errors. That benchmark harness and its logs are not in this repository, so the
256-way result is not reproducible here; the repeatable live proof is
`integrations/postgres/concurrency.ts`, whose recorded run used 16 workers (CI
sets `SYNTH_POSTGRES_WORKERS=32`) and covers clock skew and hard agent takeover.

The same reported pass also ran a partitioned-vs-hot-row comparison at 128
workers directly against the database (bypassing an `kubectl port-forward`
tunnel, which was itself a throughput ceiling in an earlier pass — see
`CHANGELOG.md`). It reported the number that matters for real workloads:
**~11.8k fenced
writes/s when each worker owns a distinct agent and lease**, the normal
shape of real usage since fencing is scoped per-agent. Forcing all
workers to contend for one shared row instead drops throughput to
~1.9k/s — expected Postgres single-row lock behavior, not a defect in
this runtime. In short: this layer scales close to linearly with however
the workload naturally partitions; a bottleneck only appears if something
is specifically designed to hammer one row from many workers.

This same benchmark pass also found and fixed a real concurrent
schema-install race (many replicas bootstrapping a fresh database at
once could hit `duplicate key ... pg_type_typname_nsp_index`); see
`CHANGELOG.md` for the fix (`pg_advisory_xact_lock` around
`installPostgresSchema`).

## Important operational caveats

PostgreSQL lease acquire, renew, release, and validity checks derive time from `clock_timestamp()`. Caller timestamps are ignored by the PostgreSQL lease implementation.

Route-health writes are currently last-write-wins JSON records: `putRouteHealth()` does a whole-JSON-body `ON CONFLICT ... DO UPDATE SET body=EXCLUDED.body`, so a concurrent writer can overwrite another writer's body wholesale rather than merging fields. Under very high concurrent failure traffic, exact success/failure counters can lose increments even though routing remains conservative enough for this reference implementation. Atomic counter/CAS updates are a tracked future improvement (see `docs/RELEASE-GATE.md`).
