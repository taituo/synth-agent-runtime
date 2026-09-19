# PostgreSQL persistence

`PostgresPersistence` implements three runtime storage roles behind one database adapter:

```text
DurabilityProvider   agent/task/relation/event state
RuntimeStateStore    commands/checkpoints/turns/effect receipts
WorldStore           project/task/artifact canonical world
```

Atomic `claimCommand()` and `claimEffect()` prevent two workers from both becoming the owner of one logical identity. `integrations/postgres/concurrency.ts` tests that contract with multiple independent database connections when `SYNTH_POSTGRES_URL` is configured.

## Important limits found by the v0.7 review

Atomic receipt claiming does **not** make every store operation concurrency-safe. In particular:

- whole `ProjectSpec`/`TaskSpec` JSONB writes are last-writer-wins;
- `listEvents()` is currently an unbounded full log read;
- a `started` command is fail-closed but has no lease/reconciliation protocol.

These are v0.8 P1 items: project mutation CAS/operations, event cursors/retention, and explicit command ownership/reconciliation.

## Live verification

```bash
export SYNTH_POSTGRES_URL='postgres://...'
npm run live:proof
```

or directly from `integrations/postgres/` run the smoke + contention programs. The included CI workflow starts a real PostgreSQL service. The artifact build environment itself had no PostgreSQL service, so the live check was skipped here rather than reported as passed.
