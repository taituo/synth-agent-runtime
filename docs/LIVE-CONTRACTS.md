# Live contracts

## v0.9 live contracts

The PostgreSQL live concurrency contract now includes two additional release gates: extreme worker clock skew must not change lease ownership, and a generation-1 agent writer must be rejected after generation 2 takes over. These run automatically when `SYNTH_POSTGRES_URL` is configured and the Postgres integration dependencies are installed.

v0.9 retains the live-system contract approach and adds hard-fencing/database-clock expectations.

## Always runnable

- TypeScript build + root tests (`npm test`)
- Postgres store contract (`npm run postgres:contract`)
- Responses protocol contracts (`npm run responses:contract`)
- integration TypeScript/shell syntax checks (`npm run integrations:syntax`)

The deterministic chaos matrix and the real child-process SIGKILL test were
retired with the homegrown runtime/chaos harness (`docs/history/museum/`); the
durable SIGKILL/restart proof is now a Temporal live proof
(`docs/VERIFICATION.md`).

## Infrastructure-dependent

- PostgreSQL multi-connection contention, including lease and project-CAS winner tests
- Pi checkout E2E using the pinned/current integration target (the Pi adapter is
  now quarantined; this exercises the memory-workspace path)
- Kubernetes/gVisor Pod deletion during execution
- external gateway/provider probe

`npm run live:proof` is the canonical aggregator. Missing infrastructure produces SKIP.

For `v1.0.0-rc.1`, the full infra-dependent contract set above (PostgreSQL, Kubernetes + gVisor, Pi, external provider) was actually executed and passed live, not just described — see `README.md`'s "Tests executed for this artifact" section and `CHANGELOG.md` for the specifics; this document intentionally does not restate the exact numbers to avoid drift.
