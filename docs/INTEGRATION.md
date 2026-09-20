# Integration guide

> **Runtime consolidation (2026-09-20).** Temporal is the single durable engine
> and the shared `GatewayAgentEngine` is the one turn body. The homegrown
> `AgentRuntime`, `DurableTurn`/`transactional-turn`, `TemporalDurabilityProvider`,
> `EffectReconciler`, `AgentRunner`/`LeasedAgentRunner`, `CommandCoordinator`,
> `EffectPolicy` and orchestration `Supervisor` were deleted (`CHANGELOG.md`,
> Unreleased). References below to those APIs are historical. The Postgres stores
> (leases/fencing, effect receipts, mailbox cursors, world revisions) remain; see
> the root `README.md` and `docs/KNOWN-OPEN.md` for the current shape.

## Local contracts

```bash
npm install
npm test
npm test --prefix integrations/temporal
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

Pi and OpenCode-style clients are an optional, tested integration path, not a requirement to use the runtime — the runtime is independent of any particular agent harness or model provider (see `README.md`'s "Agent and provider integrations" section).

The Pi E2E integration lives in `integrations/pi-e2e/`. The package keeps normal Pi read/write/edit/bash tool semantics while substituting the synthetic execution environment. Set `PI_REPO` for the live-proof script to run against a checkout.

## OpenCode / OpenAI-compatible clients

Use the gateway's `/v1/responses` or `/v1/chat/completions` endpoint and a logical model ID. The router selects provider/account routes underneath. The gateway does not inject an extra agent system prompt.

For multi-replica continuation/routing, inject the PostgreSQL distributed store into the gateway/router/OpenCode adapter instead of process-local stores.

## Kubernetes

The existing v0.7 Kubernetes/gVisor resource classes and warm-pool integration remain. `SYNTH_K8S_LIVE=1 npm run live:proof` enables the destructive live Pod-kill contract when a suitable cluster is configured.

## v0.9 ownership integration

For multi-replica agent execution, route runs through `LeasedAgentRunner`. Custom lease stores must implement `validateLease()`. Custom distributed durability stores should implement `putAgentFenced()` so stale generations are rejected atomically with the state mutation.

## Git-backed workspace trust boundary

`NativeGitSource`'s `ref` and `remote` inputs are treated as trust-boundary inputs, not passed to git unchecked: any code path that lets a task or tenant choose a workspace source ref is handling potentially untrusted data. An option-like value (one starting with `-`, such as `--upload-pack=<cmd>`) is rejected outright before it reaches git, and the underlying `git fetch` call additionally uses an end-of-options (`--`) separator as defense in depth. Both layers are verified independently by `test/native-git-source-security.test.ts`.
