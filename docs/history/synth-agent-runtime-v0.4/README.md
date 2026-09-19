# Synth Agent Runtime v0.4

v0.4 hardens the runtime around the failure modes that matter most for long-running coding agents: control-plane restart, provider failover, duplicate external effects, warm-sandbox reuse, and lazy Git hydration.

The main idea remains the same: a logical agent is durable state, not a process or Pod.

```text
User / OpenCode / TUI / Supervisor
                │
                ▼
            AgentRuntime
      ┌─────────┼─────────────┐
      │         │             │
 Durable state  World       Inference gateway
      │         │             │
      │      Super graph       ├ virtual models
      │                        ├ session affinity
      │                        └ provider/account fallback
      │
      ▼
 Durable turn boundary
 ├ workspace snapshot
 ├ buffered output/tool events
 ├ replay-safe attempt effects
 ├ commit-staged effects
 └ crash rollback
      │
      ▼
 MemoryWorkspace
 ├ RAM COW-style overlay
 └ Native Git base
      ├ shallow/partial fetch
      ├ sparse visibility
      └ persistent cat-file --batch
      │
      ▼
 ExecutionBroker
 ├ synthetic
 ├ Kubernetes/gVisor warm pool
 └ ProjectCell
```

## What v0.4 adds

### Durable runtime recovery

`AgentRuntime` can now be created with a `RuntimeStateStore` and rebuilt after a fresh process start.

- workspace checkpoints are serialized separately from live JS objects;
- non-terminal agent snapshots are reconstructed with caller-provided definition/engine factories;
- interrupted turns left in `started` state are rolled back to their pre-turn workspace snapshot;
- duplicate mailbox delivery can use a stable message ID;
- `AgentRuntime.command(id, fn)` provides a small at-most-once logical command boundary for RPC/Temporal retries.

Reference stores:

- `LocalRuntimeStateStore` — tests/in-process use;
- `JsonFileRuntimeStateStore` — single-process durable prototype using temp-file + atomic rename.

For a multi-writer production control plane, replace the JSON implementation with Postgres/SQLite/another transactional store behind the same interface.

### Durable transactional turns

`DurableTurn` and `runDurableTransactionalTurn()` extend the earlier workspace-only transaction.

```text
provider A attempt
  ├ mutate RAM workspace
  ├ buffer output
  ├ buffer tool events
  └ fail before semantic exposure
          │
          ▼
       rollback
          │
provider B attempt
  ├ starts from same workspace snapshot
  └ succeeds
          │
          ▼
        commit
  ├ run staged commit effects
  ├ publish buffered tool events
  └ publish buffered output
```

Effects are classified as:

- `attempt-local` — may execute inside the attempt; intended for synthetic/isolated execution;
- `commit` — staged until commit;
- `barrier` — executes immediately and makes transparent retry unsafe.

The default classifies `workflow.run` as commit-staged and `human.approval` as a barrier. Callers can override the classifier.

### Durable effect receipts

`ExecutionBroker` can share the same `RuntimeStateStore`. `effect.id` becomes the idempotency key.

- committed effects return the stored result instead of executing twice;
- an effect left in `started` state after a crash is reported as `EFFECT_OUTCOME_UNCERTAIN:<id>` rather than blindly replayed;
- failed effects retain a failure receipt.

This deliberately prefers duplicate prevention over automatic repetition of an external side effect with an unknown outcome.

### Better inference routing

`ProfileRouterBackend` now keeps session affinity with `x-synth-session` or `x-opencode-session`, honors `Retry-After`, and drops sticky affinity when a pinned route becomes unhealthy.

The gateway still does not replay after a successful streaming `Response` has been returned to the client. Stronger replay belongs inside the durable turn boundary where workspace and semantic output can be coordinated together.

### Native Git batch hydration

`NativeGitSource` still uses a checkout-less bare shallow/partial repository and sparse visibility, but blob reads now reuse a persistent native `git cat-file --batch` process.

An individual blob hydration limit defaults to 32 MiB and can be changed with `maxBlobBytes`.

### Stronger warm-pool reset handling

`SandboxBackend` may implement `verifyReset()`. `WarmSandboxPool` destroys the Pod if reset verification fails instead of returning it to the ready pool.

`KubectlSandboxBackend` verifies that `/workspace` and `/tmp` are empty after reset.

## Existing v0.3 capabilities retained

- logical `AgentRuntime`, tasks, relations, artifacts and inference profiles;
- project/spec world with projections;
- Super delegation/fan-out/review relationships;
- RAM workspaces, fork/snapshot/diff artifacts;
- shallow/partial/sparse native Git backing;
- OpenAI-compatible HTTP gateway and OpenCode subscription-stack integration sources;
- Kubernetes/gVisor resource classes, warm pools and ProjectCell;
- optional Temporal integration package;
- Pi harness/runtime bridge source;
- effect policy/approval layer;
- all earlier Markdown/spec documents under `docs/history/`.

## Build and test

```bash
npm run build
npm test
npm run demo
npm run gateway:demo
npm run super:demo
npm run transaction:demo
npm run recovery:demo
npm run durable-transaction:demo
```

The v0.4 root suite currently contains **20 passing tests**, including process-style runtime reopen, interrupted-turn rollback, durable effect idempotency, semantic-output buffering, barrier effects, provider session affinity, checkout-less Git batch reads, Kubernetes reset verification, workspace sync-back and all earlier v0.3 tests.

Optional Pi/OpenCode/Temporal integrations remain source bundles because they depend on their external monorepos/SDKs and are intentionally not pulled into the small root build.

## Documentation

- `README.md` — overview and quick start.
- `ARCHITECTURE.md` — system architecture.
- `RECOVERY.md` — process restart, checkpoints and command/effect idempotency.
- `TRANSACTIONS.md` — turn commit/rollback and semantic boundaries.
- `HARDENING.md` — current safety/failure model and remaining gaps.
- `OBSERVABILITY.md` — trace interface and recommended production fields.
- `INFERENCE.md` — virtual models, account stacking and affinity.
- `KUBERNETES.md` — resource classes, gVisor and warm-pool isolation.
- `TEMPORAL.md` — durable workflow integration.
- `WORLD.md` — canonical project/task world.
- `SUPER.md` — supervisor graph.
- `SPEC.md` — original long design specification.
- `ROADMAP.md` — next production layers.
- `docs/MARKDOWN-MANIFEST.md` — complete Markdown inventory.
