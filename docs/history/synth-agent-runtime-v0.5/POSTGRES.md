# Postgres persistence

v0.5 introduces `PostgresPersistence`, a single implementation of `DurabilityProvider`, `RuntimeStateStore`, and `WorldStore`.

## Why one persistence object

The runtime has three logically different stores but they often need to share one transactional database in production:

```text
agents/tasks/relations/events   -> DurabilityProvider
turns/effects/checkpoints       -> RuntimeStateStore
projects/tasks/artifacts        -> WorldStore
```

Postgres keeps these concerns as separate tables while using one driver/pool.

## JSONB + indexed identity/status

Canonical records are stored as JSONB. This lets TypeScript record schemas evolve without a SQL migration for every new metadata field. Columns required for concurrency/recovery are duplicated relationally:

- command/effect/turn `status`;
- turn `workspace_id`;
- relation identity;
- event sequence.

## Atomic claims

`RuntimeStateStore` now optionally exposes:

```ts
claimCommand(record)
claimEffect(record)
```

Postgres implements these with `INSERT ... ON CONFLICT ... RETURNING`.

Commands may be reclaimed only from `failed`; committed and currently-started commands are not double-owned. Effects are stricter: once an effect ID exists, it is never automatically reclaimed. A `started` effect represents an uncertain external outcome after a crash.

## Driver binding

Core does not import `pg`. It depends on the structural `PgExecutor` interface. `integrations/postgres/node-pg.ts` provides the `node-postgres` binding.

```ts
const opened = await openPostgresPersistence({
  connectionString: process.env.SYNTH_POSTGRES_URL,
});

const runtime = new AgentRuntime(
  opened.persistence,
  broker,
  new Map(),
  opened.persistence,
);
```

The same object can also be passed anywhere a `WorldStore` is expected.

## Local smoke

A Compose file is included under `deploy/postgres/docker-compose.yaml`.

```bash
cd deploy/postgres
docker compose up -d
cd ../../integrations/postgres
npm install
SYNTH_POSTGRES_URL=postgres://synth:synth@127.0.0.1:5432/synth npx tsx smoke.ts
```

The sandbox used to build this artifact does not provide Docker/Postgres, so the live-database smoke is supplied but was not executed here. Root tests exercise the persistence contract and atomic claim behavior with a deterministic fake driver.
