# Architecture

The runtime is **Temporal-driven**: Temporal owns durable execution and state, and
one shared turn body does the model/tool work. This document describes what
exists now. (The pre-consolidation design — a homegrown agent runtime and
control plane — is archived under `docs/history/`.)

```text
┌─────────────────────────────────────────────────────────────┐
│ Clients                                                     │
│ Temporal client · OpenAI-compatible gateway client          │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│ Temporal (the durable engine)                               │
│ durableAgentWorkflow  — agent lifecycle + mailbox           │
│ runGraphWorkflow      — loops / fan-out / join / branches   │
│ runTurn activity      — one turn, the shared turn body      │
└───────────────┬──────────────────────────┬──────────────────┘
                │                          │
     ┌──────────▼─────────┐      ┌─────────▼─────────────────┐
     │ GatewayAgentEngine │      │ Inference Gateway         │
     │ the one turn body  │      │ Chat + Responses          │
     │ → gateway call     │      │ router / affinity         │
     │ → tool calls       │      │ continuation / tenant     │
     └──────────┬─────────┘      └─────────┬─────────────────┘
                │                          │
     ┌──────────▼──────────────────────────▼─────────────────┐
     │ Execution rung (ExecutionBroker)                      │
     │ synthetic (in-memory, UNISOLATED)                      │
     │ sandbox   (persistent gVisor Pod: workspace + exec)    │
     └──────────┬─────────────────────────────────────────────┘
                │
     ┌──────────▼─────────────────────────────────────────────┐
     │ Durable stores (PostgreSQL)                            │
     │ leases/fencing · effect receipts · mailbox cursors     │
     │ world CAS · continuations · route health · rate limits │
     └────────────────────────────────────────────────────────┘
```

## Durable execution (Temporal)

- `durableAgentWorkflow` owns the agent's lifecycle, status and mailbox. It is
  the agent-lifecycle leaf.
- Each turn runs as the `runTurn` activity, which invokes the shared
  `GatewayAgentEngine` (`src/runtime/gateway-engine.ts`). The activity makes no
  model HTTP call of its own.
- `runGraphWorkflow` (`integrations/temporal/src/graph-workflow.ts`) composes
  turns into durable flows: `loop`, `fanout` (parallel children, joined),
  `branch`, and `child` workflows (a nested graph, or `durableAgentWorkflow`).
  It exposes a `cancelGraph` signal and a `getGraphState` query, and
  continues-as-new after `CONTINUE_AS_NEW_AFTER_NODES` completed nodes.
- Failure semantics: a permanent failure ends the agent; a transient failure is
  retried by Temporal, then the workflow parks with backoff (server retry hints
  honoured). A `waiting` activity return defers the turn without consuming its
  mailbox.
- Worker death: Temporal retries the in-flight activity and replays the rest
  from history. Committed turns are not re-run — proven live by
  `integrations/temporal/durable-restart-worker.ts` and
  `graph-restart-worker.ts`.

## The turn body

`GatewayAgentEngine.run(messages, context)` is the only turn body:

1. calls an OpenAI-compatible provider (`baseUrl` + `model` from configuration,
   see `docs/INFERENCE.md`);
2. maps the model's tool calls to execution-rung `Effect`s (`toEffect`), and
   calls `context.executeEffect` for each;
3. returns the assistant content, tool calls and observations.

The `runTurn` activity resolves the per-agent `turnConfig` (system prompt, tool
surface, rung selection) and sets `executeEffect` on the context. There is no
second turn body and no second model client.

## Execution rung

`ExecutionBroker` (`src/execution/broker.ts`) selects an `Executor` by fidelity
and policy, and records an effect receipt keyed by `effect.id`:

- **synthetic** (`src/execution/synthetic.ts`) — `MemoryWorkspace`, fidelity 0.
  It is explicitly **unisolated**; a scored run refuses it
  (`assertRungAllowedForScored`). It is the cheap rung.
- **sandbox** (`src/execution/kubernetes/sandbox-workspace.ts`,
  `src/execution/kubernetes/executor.ts`) — a persistent Kubernetes/gVisor Pod
  where `workspace.read/write/list/delete` **and** `process.exec` run. The
  `MemoryWorkspace` is only a seed/checkpoint cache, never the medium.

An effect receipt left `started` by a crash is returned as
`EFFECT_OUTCOME_UNCERTAIN`; it is never blindly replayed.

## Durable stores (PostgreSQL)

Postgres is the store for what is genuinely store-shaped, and it is the only
durability that remains outside Temporal:

- **leases + fencing** — `synth_leases` with monotonic fencing tokens and the
  database clock; `putAgentFenced()` validates owner, token and DB-time expiry
  atomically.
- **effect receipts** — `claimEffect`/`putEffect`; a committed receipt is
  replayed, a started one is uncertain.
- **mailbox** — `appendMailbox` returns `{ envelope, inserted }`, so only the
  inserting replica steers; named consumer cursors and ACK clamping.
- **world** — project/task/artifact revision CAS.
- **inference shared state** — continuation store, route health/affinity,
  tenant rate limits (`PostgresDistributedControlStore`).
- **events** — append-only, sequence-addressable, with a named-consumer ACK
  registry and a safe retention watermark.

`test/postgres.test.ts` and `test/postgres-control.test.ts` cover the store
contracts; `integrations/postgres/concurrency.ts` is the live 32-worker
concurrency + hard-fencing proof, run in CI on every push.

## Ownership and fencing

A lease says which worker may drive a resource; ownership is not identity. Every
re-acquisition gets a higher fencing token, and the fence is enforced at the
persistence layer:

```text
worker A: fence 41 ── expires
worker B: fence 42 ── owns resource
worker A: late write with 41 ── rejected (AGENT_FENCE_REJECTED)
```

`PostgresPersistence.putAgentFenced()` commits only when the matching
`synth_leases` row still has the same owner/token and is unexpired by
PostgreSQL's own clock; `synth_agents.fencing_token` prevents generation
regression. A stale worker never publishes a false terminal state.

## Mailbox

The durable mailbox is append-only from the consumer's perspective; delivery is
at-least-once until ACK, and effectively-once only when the consumer's work is
idempotent. In the runtime path the workflow owns the mailbox
(`durableAgentWorkflow` splices exactly the messages a turn consumed); the
Postgres `MailboxStore` is the shared store for multi-replica consumers.

## World concurrency

Projects, tasks and artifacts use optimistic concurrency: read a revision,
modify, `compareAndSwap(expected)`; a stale writer receives the current record
instead of overwriting it. `putProject()` accepts only a strictly newer
revision once a project exists.

## Inference

`ProfileRouterBackend` routes a virtual model across provider routes with
failover, cooldown and tenant-scoped sticky affinity. `RouterStateStore` and
`ContinuationStore` can be PostgreSQL-backed, so a gateway replica is
disposable. Providers are configuration (`src/inference/gateway/provider-config.ts`),
not code; `opencode-go` is one provider among many.

## Workspace and physical execution

Source manipulation starts in `MemoryWorkspace` (lazy Git source, snapshots,
diffs). On the sandbox rung the workspace lives in the Pod; on the synthetic
rung it is in-process RAM. A checkpoint syncs the Pod back into the cache and
writes the workspace diff to the blob store (`snapshot-codec.ts` +
`exportArtifact`); a large workspace uses the git transport. Warm sandbox reset
is verified before reuse; a failed reset destroys the slot.

## Recovery

- **Interrupted turn, no external effect** — Temporal retries the activity; no
  committed side effect is repeated.
- **Crash near an external effect** — the effect receipt stays `started`, and a
  later attempt gets `EFFECT_OUTCOME_UNCERTAIN` rather than a blind replay.
- **Worker death** — Temporal replays committed history and retries only the
  in-flight activity (live-proven, see above).

The store-level `putAgentFenced()` invariant is covered by
`test/postgres-control.test.ts` and the live concurrency proof.

## Storage hierarchy

```text
Temporal
├ workflow history (lifecycle, mailbox, graph position, timers, retries)
└ activity/child-workflow records

PostgreSQL
├ agents/tasks/relations/events
├ command/turn/effect receipts
├ projects/artifacts
├ leases
├ mailbox + consumer cursors
├ Responses continuations
└ route health + affinity

RAM
├ live GatewayAgentEngine objects
├ MemoryWorkspace overlays (synthetic rung / sandbox seed cache)
└ attached client listeners
```

Temporal is canonical for execution; PostgreSQL is canonical for the stores it
owns; RAM is acceleration, not truth.
