# Integration guide

## Local contracts

```bash
npm install
npm test
npm run distributed:contract
npm run release-hardening:contract
npm run process-crash:contract
npm run responses:contract
npm run integrations:syntax
```

## PostgreSQL

Install `deploy/postgres/001_runtime.sql`, `002_distributed_control_plane.sql`, and `003_release_hardening.sql`, then use `integrations/postgres/node-pg.ts` or the core `PostgresPersistence` + `PostgresDistributedControlStore` classes.

For a real contention run:

```bash
SYNTH_POSTGRES_URL=postgres://... npm run live:proof
```

## Pi

The Pi E2E integration lives in `integrations/pi-e2e/`. The package keeps normal Pi read/write/edit/bash tool semantics while substituting the synthetic execution environment. Set `PI_REPO` for the live-proof script to run against a checkout.

## OpenCode / OpenAI-compatible clients

Use the gateway's `/v1/responses` or `/v1/chat/completions` endpoint and a logical model ID. The router selects provider/account routes underneath. The gateway does not inject an extra agent system prompt.

For multi-replica continuation/routing, inject the PostgreSQL distributed store into the gateway/router/OpenCode adapter instead of process-local stores.

## Kubernetes

The existing v0.7 Kubernetes/gVisor resource classes and warm-pool integration remain. `SYNTH_K8S_LIVE=1 npm run live:proof` enables the destructive live Pod-kill contract when a suitable cluster is configured.

## v0.9 ownership integration

For multi-replica agent execution, route runs through `LeasedAgentRunner`. Custom lease stores must implement `validateLease()`. Custom distributed durability stores should implement `putAgentFenced()` so stale generations are rejected atomically with the state mutation.
