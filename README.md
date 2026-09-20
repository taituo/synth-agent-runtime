# Synth Agent Runtime

**Infrastructure for running AI agents as durable, distributed workloads.**

> **Node >= 22 is required.** Node 18 silently breaks the gym scorer's
> permission model and turns the held-out-vector tests into false failures.
> Run `node --version` and confirm `v22.x` before trusting any red.

Synth Agent Runtime is a runtime for long-running AI agents. It turns an agent from a process-bound chat session into a durable entity with its own state, lifecycle, mailbox, execution environment, recovery semantics, and ownership rules.

The runtime is designed for agents that may run unattended for minutes, hours, or longer; move between workers; survive process and machine failures; receive steering while they are already running; spawn or coordinate other agents; and eventually act on external systems. The agent itself can remain relatively simple. The runtime is responsible for making its execution reliable.

At the center of the design is a separation between **agent reasoning, durable state, and physical execution**. An agent can work against a fast in-memory workspace, a persistent project environment, or an isolated Kubernetes/gVisor sandbox without changing the higher-level agent model. Expensive or consequential operations can be pushed behind explicit execution and effect boundaries rather than being implicit side effects of an LLM conversation.

Durability is **Temporal's job**: `durableAgentWorkflow` owns the agent loop and mailbox, and every turn executes as the `runTurn` activity through the shared `GatewayAgentEngine` turn body (`src/runtime/gateway-engine.ts`). There is no homegrown durable-turn or control-plane stack — the earlier `AgentRuntime`/`DurableTurn`/`CommandCoordinator`/`Supervisor` modules were deleted, because they duplicated what Temporal provides. Postgres remains the store for what is genuinely store-shaped: leases and fencing tokens, effect receipts, mailbox cursors, world revisions, and rate limits. Its 32-worker concurrency + hard-fencing proof runs in CI (`integrations/postgres/concurrency.ts`, `postgres-live.yml`).

The runtime also includes an inference layer with OpenAI-compatible Chat Completions and Responses endpoints, streaming and tool-call support, continuation handling, routing, and provider abstraction. This allows agent execution to remain independent of a particular model provider or client surface.

Synth is **not an agent framework, prompt library, or a new model SDK**. Existing agent harnesses can sit on top of it. Pi, OpenCode-style clients, supervisors, workflow systems, or custom agents can use the runtime while Synth handles the less visible systems problems underneath them: ownership, persistence, isolation, recovery, concurrency, and safe interaction with the outside world.

The broader goal is to make agents behave more like normal distributed workloads: cheap to create, safe to interrupt, recoverable after failure, movable between execution environments, and able to continue working independently of the client that started them.

**Current release: `1.0.0-rc.1`.** The release candidate was exercised against real PostgreSQL concurrency, a pinned Pi checkout E2E, Kubernetes with gVisor isolation, and a live external inference provider. The tree has since been consolidated — the homegrown control plane was deleted and the Pi adapter/bridge was quarantined as unwired — so the evidence that holds today is the suites and live proofs listed below and in `docs/KNOWN-OPEN.md`; the original RC run is documented in `docs/RELEASE-GATE.md` and `docs/history/`.

> **Release-candidate status.** This tree folds together the external v0.9
> audit fixes, the second review's cross-replica race fixes (atomic agent
> creation, mailbox-insertion-winner steering), a gateway abort-safety fix
> (a disconnecting client could crash the whole process), and a git
> ref/remote argument-injection fix (a workspace source ref could reach
> git's own option parser and run a program on the control-plane host). See
> `docs/SECOND-REVIEW.md` and `CHANGELOG.md` for the full history, including
> the known issues carried into this RC.


The central invariant — one turn implementation, sandboxed code:

```text
durableAgentWorkflow (Temporal owns lifecycle + mailbox)
        │  runTurn activity
        ▼
GatewayAgentEngine.run(messages, context)   ← the single turn body
        │
        ├─ calls the OpenAI-compatible gateway
        └─ executes the model's tool calls via context.executeEffect
                │
                ▼
        ExecutionBroker (execution rung)
                │
                ├─ synthetic / in-memory workspace (cheap, fidelity 0)
                └─ Kubernetes + gVisor executor Pod (process.exec)
```

The workflow's per-agent `turnConfig` (system prompt, tool surface, rung
selection) is carried into the activity, which resolves the rung and sets
`executeEffect`; a tool call then runs instead of being refused. Model-authored
code only ever runs through the execution rung, never in the worker process.
The `runTurn` activity is a thin Temporal adapter over the engine; it makes no
model HTTP call of its own.

A separate store-level invariant still holds for fenced writes: a stale worker
cannot publish a later terminal `AgentSnapshot` after a newer lease generation
has taken ownership, enforced atomically by `PostgresPersistence.putAgentFenced()`
against `synth_leases` (owner, fencing token, and PostgreSQL-clock expiry).

## Composing agents: the graph harness

`durableAgentWorkflow` is the leaf; the graph harness composes leaves into
durable flows. A `GraphStep` (serializable, so it survives `continueAsNew`) is a
`turn` (the `runTurn` activity), an `activity`, a `child` workflow (the agent
leaf or a nested graph), or a composite: `sequence`, `fanout` (parallel children
joined when all complete), `branch` (a data predicate), and `loop` (iterate until
a condition, with the counter in workflow state). `runGraphWorkflow` exposes a
`cancelGraph` signal and a `getGraphState` query, and continues-as-new after
`CONTINUE_AS_NEW_AFTER_NODES` completed nodes. The interpreter is pure, so the
composition logic is unit-tested without a server; a live proof SIGKILLs a worker
mid-graph and shows committed loop/join nodes are not re-run. See
`docs/HARNESS.md`.

## Agent-state fencing

### Hard agent-state fencing

`DurabilityProvider` has an optional `putAgentFenced(snapshot, fence)` primitive. The `LeasedAgentRunner`/`CommandCoordinator` helpers that used to pass a lease generation through the deleted `AgentRuntime` are gone with it; the primitive and its atomic Postgres validation remain, because the fenced-write invariant is a store property and is exercised directly by `test/postgres-control.test.ts` and the 32-worker live proof.

PostgreSQL validates the proof atomically against `synth_leases`. An unfenced update is allowed only while the agent row is still at fencing generation `0`; once fenced ownership has begun, legacy/unfenced updates are rejected with `AGENT_FENCE_REQUIRED`.

Local in-memory and JSON-file providers retain monotonic fenced generations for deterministic tests, while remaining usable as explicitly single-writer stores.

### Database-clock leases

PostgreSQL acquire, renew, release, and validity checks now derive time from `clock_timestamp()` inside PostgreSQL. The optional `now` parameter remains in the `LeaseStore` interface for deterministic in-memory tests, but the PostgreSQL implementation deliberately ignores worker-local time.

`LeaseStore.validateLease()` exists so commit logic does not compare PostgreSQL lease timestamps against `Date.now()` from another machine. The store is covered by `test/postgres-control.test.ts`.

### Live PostgreSQL proof extended

`integrations/postgres/concurrency.ts` now additionally checks:

```text
worker A clock = absurdly far in the past
worker B clock = absurdly far in the future
              │
              ▼
PostgreSQL clock remains authoritative
              │
              └─ B cannot steal A's unexpired lease
```

It also exercises generation-1 → generation-2 agent takeover and verifies that generation 1 cannot publish after generation 2 wins.

### Migration

`deploy/postgres/003_release_hardening.sql` adds `synth_agents.fencing_token`. Fresh installs also include the column through `POSTGRES_SCHEMA_SQL` and `001_runtime.sql`.

## Runtime layers

```text
Clients / OpenCode / Pi / Temporal client
                    │
        durableAgentWorkflow (Temporal)
                    │  runTurn activity
                    ▼
        GatewayAgentEngine  ← the one turn body
                    │
       ┌────────────┼───────────────┐
       │            │               │
 durable world   mailbox        inference
 CAS/revisions  seq + ACK   continuation/router
       │            │               │
       └────── Postgres stores ─────┘
                    │
          lease + fencing token
                    │
        ┌───────────┴───────────┐
        │                       │
 AgentSnapshot writes      effect receipts
 hard-fenced in DB        claimed in DB
        │                       │
        └───────────┬───────────┘
                    │
             Execution Broker
          ┌─────────┴──────────┐
          │                    │
 synthetic RAM          physical sandbox
 MemoryWorkspace       Kubernetes / gVisor
```

### Agent and provider integrations

Synth Agent Runtime is independent of any particular agent harness or model provider.

It can be embedded underneath existing agents and coding harnesses, or used with custom workers that implement the runtime interfaces. There is no bundled agent harness: the former `PiAgentEngine` and Pi bridge had no caller and are quarantined to `docs/history/museum/` (see `docs/KNOWN-OPEN.md`); a custom worker supplies the turn body or binds the shared one.

The inference gateway is provider-agnostic and exposes OpenAI-compatible Chat Completions and Responses interfaces. Providers are configuration, not code: `provider-config.ts` builds the router from a declared list (`{ id, baseUrl, apiKey?, model, profile? }`, from `SYNTH_GATEWAY_PROVIDERS`/`SYNTH_PROVIDER_*`), and a synthetic/cheap run can call any declared provider **directly** via `directProviderSettings()` with no opencode or Pi dependency. `opencode-go` is one profile among many. Provider limits are unmeasured unless a live key was present (see `docs/KNOWN-OPEN.md`); no provider or key is hardcoded.

Provider credentials are not bundled with Synth. Deployments supply and manage their own credentials and are responsible for complying with the terms and usage policies of the provider they choose.

## Tests executed for this artifact

Measured under Node v22.20.0 (`node --version`), on commit `HEAD`:

```text
npm test  (root suite)
196 passed / 0 failed

npm test --prefix integrations/temporal  (durable workflow + turn body + graph harness)
89 passed / 0 failed

npm run integrations:syntax
81 TypeScript integration files / 0 syntax diagnostics
3 shell files / syntax OK

integrations/opencode-http-gateway: npm test
3 passed / 0 failed  (abort-safety contract)
```

Also independently verified live, outside this repeatable suite (not
re-runnable without external infrastructure/credentials): real PostgreSQL
concurrency and fencing under **32** concurrent workers, a real pinned Pi
checkout E2E, a real Kubernetes + gVisor pod-kill, and a full
external-provider matrix (unknown-model/malformed/missing-model errors,
abort-survival, `previous_response_id` continuation, tool calls, 3-way
concurrency) against a live subscription-backed gateway. (The Pi adapter is now
quarantined as unwired; the pinned Pi checkout E2E was a real run of the
memory-workspace path, see `docs/PI-E2E.md`.) `npm run live:proof` /
`node scripts/live-proofs.mjs` run the same checks and report **SKIP** (not
PASS) for whichever of these require infrastructure/credentials this
environment doesn't have.

## Start here

```bash
npm install
npm test
npm test --prefix integrations/temporal
npm run live:proof
```

Current docs: `docs/TEMPORAL.md` (the runtime), `docs/HARNESS.md` (the graph
harness), `docs/POSTGRES.md`, `docs/INFERENCE.md`, and `docs/KNOWN-OPEN.md`.
`docs/ARCHITECTURE.md`, `docs/DISTRIBUTED.md`, `docs/HARDENING.md`,
`docs/RECOVERY.md`, `docs/TRANSACTIONS.md`, `docs/SUPER.md`, `docs/CHAOS.md` and
`docs/WORLD.md` are retained as design history; each carries a banner.

`docs/` holds every other design/subsystem doc (see `docs/README.md` for the
full index). All prior release documentation (the v0.1–v0.8 root Markdown
sets) and the retired versioned tests/examples are retained under
`docs/history/` for archival reference; nothing there is compiled or run.

## Release status

`1.0.0-rc.1` is the current tag, but the tree no longer matches its original
release note: the homegrown durable-control-plane stack was deleted and
Temporal is now the single durable engine (`CHANGELOG.md`, Unreleased). The
claims that remain measured are the Postgres concurrency/fencing proof (32
workers, CI on every push), the Temporal suite, and the unit suites above.
The claims that are still **not** enforced per push are the same ones
`docs/KNOWN-OPEN.md` lists: the scoring worker is not isolated from the host,
the gym agent's tool path has no permission model, the corpus is an 8-item
smoke test, and OpenRouter limits are unmeasured. The Temporal worker deploy
manifest (`deploy/kubernetes/worker-deployment.yaml`) is a documented shape,
not applied in CI. Remaining work before a GA `1.0.0` tag is operational
hardening: a single enforced boundary for all agent-controlled execution,
sustained soak/load testing, rolling-upgrade testing, distributed rate
limiting, per-record task/artifact CAS, and continuation
retention/encryption policy.
