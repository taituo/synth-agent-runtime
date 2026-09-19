# Synth Agent Runtime v0.5

v0.5 moves the prototype from single-process durability toward a multi-process control plane. The three focus areas are **Postgres persistence**, **repeatable chaos/failure testing**, and a **real Pi AgentHarness E2E contract test** that can be installed into the current Pi monorepo.

The core rule is unchanged: a logical agent is durable state; Pods, processes, provider connections and model accounts are replaceable execution resources.

```text
OpenCode / TUI / Voice / Supervisor
               │
               ▼
          Agent Runtime
        ┌──────┼───────────┐
        │      │           │
   Durable   World     Inference gateway
     state     │            │
        │      │      OpenCode A/B/C + others
        │      │            │
        └──────┴──────┬─────┘
                      ▼
             Durable Turn Boundary
              ├ workspace snapshot
              ├ buffered semantics
              ├ effect receipts
              └ provider replay boundary
                      │
            ┌─────────┴─────────┐
            ▼                   ▼
      MemoryWorkspace      ExecutionBroker
      + lazy native Git    ├ synthetic
                           ├ gVisor/Kubernetes
                           └ ProjectCell
```

## v0.5 highlights

### Postgres as one control-plane persistence layer

`PostgresPersistence` implements all three core persistence contracts:

```text
DurabilityProvider
RuntimeStateStore
WorldStore
       │
       ▼
PostgresPersistence
       │
       ▼
PostgreSQL
```

It stores canonical TypeScript records as JSONB while keeping identity/status columns relational for recovery scans and atomic claims.

The v0.5 runtime also extends `RuntimeStateStore` with optional atomic `claimCommand()` and `claimEffect()` operations. `AgentRuntime.command()` and `ExecutionBroker` use them when available. This prevents two control-plane workers from simultaneously claiming the same logical command/effect.

`effect.id` remains the external side-effect idempotency key. If an executor throws after it may have crossed an external boundary, the receipt remains `started`/uncertain rather than being marked safely retryable.

Files:

- `src/postgres/persistence.ts`
- `src/postgres/schema.ts`
- `deploy/postgres/001_runtime.sql`
- `deploy/postgres/docker-compose.yaml`
- `integrations/postgres/`

### Deterministic chaos testing

The new chaos layer provides named failpoints instead of relying on random timing:

```ts
const chaos = new ChaosController([
  { point: "executor.execute.after", nth: 1 }
]);
```

Wrappers exist for durability, runtime state, executors and gateway backends. This allows tests such as:

```text
external effect succeeds
        │
        X process/fault immediately after return
        │
restart/retry
        │
EFFECT_OUTCOME_UNCERTAIN
        │
no duplicate execution
```

The built-in crash-recovery scenario also leaves a durable turn open, mutates the workspace, constructs a fresh runtime, and proves the pre-turn snapshot is restored.

Run the focused failure matrix with:

```bash
npm run build
node scripts/chaos-matrix.mjs
```

### Pi AgentHarness E2E contract

`integrations/pi-e2e/pi-harness.e2e.test.ts` is an installable test for the current Pi API surface. It uses Pi's real `AgentHarness`, faux model provider, session implementation, and normal `read/write/edit/bash` tools through `ExecutionEnv`.

The test proves the exact seam used by our adapter:

```text
Pi AgentHarness
      │
normal Pi tools
      │
ExecutionEnv
      │
NodeExecutionEnv in contract test
MemoryExecutionEnv in synthetic runtime
```

Install it into a Pi checkout:

```bash
./integrations/pi-e2e/install-test.sh /path/to/pi
cd /path/to/pi
pnpm vitest packages/agent/test/synth-runtime-pi.e2e.test.ts
```

The test targets the Pi source API inspected at commit `36b60d2e8985899743c4cf5bd5f8929832a3f05d`. It is included and syntax-checked here, but the Pi monorepo itself is not present in this sandbox, so that external E2E test was not executed here.

## Existing capabilities retained

v0.5 contains everything from v0.4, including durable turn rollback, workspace checkpoints, effect receipts, session-affine inference routing, checkout-less lazy Git with persistent `git cat-file --batch`, Kubernetes/gVisor warm pools, reset verification, ProjectCell, project/spec world, Super orchestration primitives, Temporal integration sources, OpenCode subscription stacking, the Pi runtime bridge, and all earlier design/history Markdown files.

## Build and test

```bash
npm run build
npm test
npm run chaos:demo
node scripts/chaos-matrix.mjs
```

The root suite currently contains **25 passing tests**. The focused chaos matrix also passes. The Postgres core is tested with a deterministic driver contract; an actual Postgres smoke test is included under `integrations/postgres/smoke.ts` and can be run with `SYNTH_POSTGRES_URL`.

## Documentation

- `README.md` — current overview and quick start.
- `ARCHITECTURE.md` — architecture and trust boundaries.
- `POSTGRES.md` — multi-process Postgres persistence and atomic claims.
- `CHAOS.md` — failpoint model and failure scenarios.
- `PI-E2E.md` — Pi contract test and runtime bridge.
- `RECOVERY.md` — process restart and interrupted-turn recovery.
- `TRANSACTIONS.md` — semantic buffering and turn transactions.
- `HARDENING.md` — current safety model and known gaps.
- `OBSERVABILITY.md` — tracing guidance.
- `INFERENCE.md` — virtual models, OpenCode account stacking and affinity.
- `KUBERNETES.md` — gVisor, warm pools and resource classes.
- `TEMPORAL.md` — Temporal integration.
- `WORLD.md` — canonical project/task world.
- `SUPER.md` — supervisor relationships/orchestration.
- `SPEC.md` — original long design specification.
- `ROADMAP.md` — next layers.
- `docs/MARKDOWN-MANIFEST.md` — complete Markdown inventory.
