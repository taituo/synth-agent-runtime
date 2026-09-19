# PostgreSQL adapter

The core package stays driver-agnostic. `node-pg.ts` binds it to `pg` and can
install the runtime schema automatically.

```bash
npm install
export SYNTH_POSTGRES_URL='postgres://postgres:postgres@127.0.0.1:5432/synth'
npx tsx smoke.ts
npx tsx concurrency.ts
```

`concurrency.ts` opens multiple independent pools and races the same command and
effect claims. A real PostgreSQL run passes only when exactly one claimant wins
each identity. Set `SYNTH_POSTGRES_WORKERS` to raise/lower contention.
