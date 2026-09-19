# Live contracts

## v0.9 live contracts

The PostgreSQL live concurrency contract now includes two additional release gates: extreme worker clock skew must not change lease ownership, and a generation-1 agent writer must be rejected after generation 2 takes over. These run automatically when `SYNTH_POSTGRES_URL` is configured and the Postgres integration dependencies are installed.

v0.9 retains the live-system contract approach and adds hard-fencing/database-clock expectations.

## Always runnable

- TypeScript build + root tests
- distributed control-plane contract
- deterministic chaos matrix
- real child-process SIGKILL recovery
- Responses protocol contracts
- integration TypeScript/shell syntax checks

## Infrastructure-dependent

- PostgreSQL multi-connection contention, including lease and project-CAS winner tests
- Pi checkout E2E using the pinned/current integration target
- Kubernetes/gVisor Pod deletion during execution
- external gateway/provider probe

`npm run live:proof` is the canonical aggregator. Missing infrastructure produces SKIP.
