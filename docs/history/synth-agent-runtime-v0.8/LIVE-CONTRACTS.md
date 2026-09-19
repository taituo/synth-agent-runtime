# Live contracts

v0.8 retains the v0.7 live-system contract approach and adds distributed-state expectations.

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
