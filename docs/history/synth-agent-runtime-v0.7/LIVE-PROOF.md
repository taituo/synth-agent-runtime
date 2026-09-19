# Live proof harness

v0.7 makes local and external verification one command instead of a set of undocumented manual steps.

```bash
npm run live:proof
```

The command always runs:

- root TypeScript build and unit/contract suite;
- integration TypeScript + shell syntax validation;
- real child-process `SIGKILL` recovery contract;
- Responses protocol contracts.

It conditionally runs external systems when configured:

```bash
SYNTH_POSTGRES_URL=postgres://... npm run live:proof
PI_REPO=/path/to/pi npm run live:proof
SYNTH_K8S_LIVE=1 npm run live:proof
SYNTH_GATEWAY_URL=http://127.0.0.1:8787 npm run live:proof
```

The live gateway probe additionally supports `SYNTH_GATEWAY_TOKEN`, `SYNTH_GATEWAY_MODEL`, and `SYNTH_GATEWAY_SESSION`.

## CI workflows

- `.github/workflows/core.yml` — build, root tests, syntax checks and process/Responses contracts.
- `.github/workflows/postgres-live.yml` — real PostgreSQL service, smoke test and multi-connection claim contention.
- `.github/workflows/pi-e2e.yml` — pinned Pi checkout plus Node and MemoryExecutionEnv E2E tests.
- `.github/workflows/kubernetes-live.yml` — manual/self-hosted gVisor runner contract for real Pod-kill behavior.

The Kubernetes workflow deliberately requires an environment that actually has gVisor configured; it does not replace gVisor with a weaker runtime and still call the test equivalent.

## What was executable in the artifact environment

Executed successfully while building v0.7:

```text
49 / 49 root tests
1 / 1 SIGKILL recovery contract
6 / 6 Responses contracts
25 integration TypeScript files: 0 syntax diagnostics
4 shell files: bash -n passed
```

Unavailable here and therefore reported as skipped rather than passed:

- live PostgreSQL (`SYNTH_POSTGRES_URL` absent; no Docker/psql service available);
- Pi monorepo E2E (`PI_REPO` absent);
- live Kubernetes/gVisor (`SYNTH_K8S_LIVE != 1`; no kubectl/cluster available);
- live external gateway/OpenCode credentials (`SYNTH_GATEWAY_URL` absent).

This distinction is part of the test contract: missing infrastructure is visible as **SKIP**, never rewritten as success.
