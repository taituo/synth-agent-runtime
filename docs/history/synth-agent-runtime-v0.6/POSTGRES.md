# Postgres persistence

`PostgresPersistence` implements `DurabilityProvider`, `RuntimeStateStore`, and `WorldStore` using JSONB records plus relational identity/status columns.

## Atomic claims

`claimCommand()` and `claimEffect()` are the multi-process ownership boundary. Commands may be reclaimed only from a previously failed state; effects are stricter because a pre-existing `started` effect can represent an uncertain external outcome.

## Live contention contract

v0.6 adds `integrations/postgres/concurrency.ts`. It creates multiple independent PostgreSQL pools and simultaneously claims the same command and effect identities.

```bash
cd integrations/postgres
npm install
export SYNTH_POSTGRES_URL='postgres://...'
export SYNTH_POSTGRES_WORKERS=32   # optional
npx tsx concurrency.ts
```

Success requires exactly one command claimant and exactly one effect claimant.

The build environment for this artifact has no PostgreSQL/Docker binary, so the live test is bundled but not marked as executed. Deterministic root tests still validate the generated claim SQL contract against a fake driver.
