# Synth Agent Runtime v0.3

v0.3 turns the earlier Pi/OpenCode experiments into one coherent runtime prototype: durable logical agents, a canonical project world, cheap RAM/Git workspaces, transactional retries, supervisor fan-out, transparent inference routing, and physical Kubernetes/gVisor execution.

```text
User / OpenCode Desktop / TUI / Voice
                 │
                 ▼
             AgentRuntime
       ┌─────────┼──────────┐
       │         │          │
  Project world  Super   Durability
       │         │          │
       │      Agent graph   ├ local
       │         │          └ Temporal integration
       │         ▼
       │      Pi engine
       │         │
       │   MemoryWorkspace ───────────┐
       │    Git base + RAM overlay    │
       │         │                    │
       │   transactional turns        │
       │         │                    ▼
       │         └────────── ExecutionBroker
       │                      ├ synthetic
       │                      ├ K8s/gVisor
       │                      └ ProjectCell
       │
       └──── Inference Gateway
              ├ virtual models
              ├ OpenCode Go stack A/B/C
              └ manual providers/fallbacks
```

## What is implemented

The root package builds and tests without Pi, Kubernetes SDK, or Temporal SDK dependencies. Optional integrations are bundled separately.

- `AgentRuntime`: one logical agent works attached/interactively or unattended.
- tasks, relations, artifacts, inference profiles and execution policies.
- `InMemoryWorldStore` plus durable single-process `JsonFileWorldStore`: canonical project objective, constraints, decisions, tasks and artifacts with compact context projections.
- `Supervisor`: delegate/fan-out/reviewer graph operations over isolated workspace forks.
- `MemoryWorkspace`: RAM-only mutable overlay, snapshots, restore, fork and diff artifacts.
- `NativeGitSource`: checkout-less shallow/partial Git backing with sparse visibility.
- transactional workspace/turn primitives for safe retry before semantic output escapes.
- `ExecutionBroker`: synthetic → Kubernetes/gVisor → ProjectCell resource classes.
- hardened Pod/NetworkPolicy generation, warm sandbox pool and workspace sync-back.
- OpenAI-compatible inference gateway.
- `ProfileRouterBackend`: stable logical model names with health/cooldown/fallback routing.
- `HttpGatewayBackend`: transparent upstream OpenAI-compatible proxy.
- Pi runtime bridge source using the current `AgentHarness`/lane/`ExecutionEnv` seam.
- OpenCode Go account-stack → HTTP Chat Completions bridge source.
- optional real Temporal workflow/client/worker integration package.
- effect allowlist/approval gate.
- all earlier Markdown design/integration documents copied under `docs/history/`.
- original long design spec promoted to `SPEC.md`.

## Important separation

A logical agent is **not** a Pod and an inference route is **not** an execution environment.

```text
AgentInstance
  ├ task + mailbox + relationships
  ├ inferenceProfile ──> gateway/provider/account
  └ workspace ─────────> synthetic / gVisor / ProjectCell
```

A Pod is a temporary execution lease. The durable agent, task graph, project world and workspace identity remain in the control plane.

## Transparent OpenCode routing

The existing account stack is bundled at `integrations/pi-opencode-stack-router/`. v0.3 adds `integrations/opencode-http-gateway/adapter.ts`, which exposes that stack as an ordinary OpenAI Chat Completions backend.

```text
OpenCode Desktop / Pi / any OpenAI client
                 │
          http://router:8787/v1
                 │
        logical model / profile
                 │
        OpenCodeStackModels
          ├ Go account A
          ├ Go account B
          ├ Go account C
          └ manual fallbacks
```

The gateway does not invent an extra system prompt. The client-supplied system/developer messages and tool declarations are translated into Pi context and sent through the selected provider. The v0.3 Pi bridge intentionally exposes Chat Completions first; lossless `/v1/responses` translation remains a later adapter task.

## Transactional retry

Synthetic workspaces can now be rolled back around a provider/turn attempt:

```text
snapshot S0
   │
provider A + tool effects
   │  transient failure before semantic output
   ▼
rollback S0
   │
provider B + tool effects
   │
commit
```

`runTransactionalTurn()` deliberately requires the caller to decide whether an error is retryable. Do not retry after user-visible text/tool semantics have escaped unless the full conversation/effect boundary is also transactional.

## Kubernetes isolation

The v0.2 physical execution layer remains included: gVisor `RuntimeClass`, non-root execution, no ServiceAccount token, no hostPath/Docker socket, dropped Linux capabilities, `RuntimeDefault` seccomp, read-only root filesystem, bounded resources and default-deny-style networking with explicit DNS/egress paths.

See `KUBERNETES.md` and `deploy/kubernetes/README.md`.

## Temporal

`integrations/temporal/` is a separate optional package with a real Temporal workflow, signals/query, client and worker bootstrap. Temporal owns durable lifecycle/mailbox state; Pi/model/tool work remains in activities. This keeps the public runtime API independent of Temporal.

## Build and test

```bash
npm run build
npm test
npm run demo
npm run gateway:demo
npm run super:demo
npm run transaction:demo
```

The root v0.3 test suite currently covers runtime attach/unattended behavior, workspace fork isolation, Kubernetes resource isolation/pooling/sync-back, execution resource-class routing, transactional rollback, project projections, JSON-file persistence, supervisor delegation and inference profile fallback.

Optional integration packages (`integrations/temporal`, Pi/OpenCode bridge sources) have their own external dependencies and are not part of the root `tsc` build.

## Documentation map

- `README.md` — start here.
- `ARCHITECTURE.md` — complete runtime architecture.
- `SPEC.md` — original long Pi synthetic-agent design spec.
- `INTEGRATION.md` — Pi/OpenCode/Kubernetes/Temporal wiring.
- `KUBERNETES.md` — physical execution and isolation.
- `TEMPORAL.md` — durable deployment model.
- `WORLD.md` — project/spec canonical state.
- `SUPER.md` — supervisor/subagent graph model.
- `INFERENCE.md` — gateway and subscription stacking.
- `TRANSACTIONS.md` — workspace rollback/failover semantics.
- `CHANGELOG.md` — version history.
- `docs/history/` — every Markdown artifact from the earlier prototypes and v0.1/v0.2 bundles.
- `docs/MARKDOWN-MANIFEST.md` — inventory of Markdown files included in this archive.
