# Architecture v0.6

## Runtime layers

```text
Presentation
  OpenCode Desktop / TUI / voice / API
                │
                ▼
Control plane
  AgentRuntime ─ Project World ─ Supervisor
      │               │             │
      ├ durable state projections   └ agent/task/review graph
      ├ inference profile ──> OpenAI-compatible gateway/router
      └ workspace ──────────> ExecutionBroker
                                  ├ synthetic RAM
                                  ├ K8s/gVisor
                                  └ ProjectCell
```

Pi is an agent-loop adapter, not the whole platform. OpenCode can either be a normal client/agent using the inference gateway or a presentation layer over runtime-owned Pi agents.

## Durable runtime state

v0.6 explicitly separates canonical state from live process objects:

```text
DurabilityProvider
  agent/task/relation/event snapshots

RuntimeStateStore
  workspace checkpoints
  command receipts
  turn records
  effect receipts

WorldStore
  project/spec/task/artifact state
```

`AgentRuntime.recover()` rebuilds live engines using caller-provided factories. A JavaScript call stack is never treated as durable state.

## First-class objects

`AgentInstance` carries identity, definition, task, workspace, inference profile, execution policy, mailbox and state. `Task` carries objective/constraints/dependencies/status. `ProjectSpec` is canonical long-lived project state. `Workspace` carries immutable source revision plus mutable RAM overlay. `Effect` is an execution request routed through policy and an executor.

## Canonical world vs context projection

Conversation history is not the project database.

```text
ProjectSpec (canonical)
  ├ constraints
  ├ decisions
  ├ tasks
  └ artifacts
          │
          ▼
ProjectProjection
  compact context text + selected records
          │
          ▼
agent turn
```

## Workspace and Git

```text
bare shallow/partial Git object store
        │
        ▼
 NativeGitSource
   ├ sparse visibility
   ├ blob-size guard
   └ persistent cat-file --batch
        │
        ▼
 MemoryWorkspace
   ├ clean reads from base
   ├ writes/tombstones in RAM
   ├ snapshot/restore
   ├ fork
   └ diff artifact
```

Shallow controls history depth, partial clone controls object hydration, and sparse controls visible paths. They remain separate dimensions.

## Durable turn boundary

```text
turn begin
  ├ persist base workspace snapshot
  ├ buffer output/tool events
  ├ execute attempt-local effects
  └ stage commit effects
        │
        ├ retryable failure before exposure -> rollback
        │
        └ success -> staged effects -> publish buffered semantics -> commit
```

Barrier effects mark the turn non-retryable. `ExecutionBroker` uses `Effect.id` as a durable idempotency key when given a `RuntimeStateStore`.

## Supervisor graph

Roles are relationships, not species:

```text
supervises
 delegates_to
 consults
 reviews
 reports_to
 shares_resource
```

`Supervisor.delegate()` forks a workspace and assigns a task. `fanOut()` creates independent workers and `assignReviewer()` adds a review edge.

## Inference

```text
client model = worker/cheap
          │
          ▼
ProfileRouterBackend
  ├ sticky session route
  ├ Retry-After/cooldown
  ├ OpenCode account stack
  └ manual provider fallback
```

Routing changes infrastructure, not the client prompt. A successful streaming response is not replayed at the network gateway; transactional replay belongs inside the durable agent turn.

## Execution fidelity ladder

```text
L0 synthetic MemoryExecutionEnv
  ↓ unsupported physical command
L1 sandbox-small gVisor
L2 sandbox-medium/heavy gVisor
L3 ProjectCell
L4 Firecracker/Kata (future)
L5 staging / production effect
```

The workspace identity remains stable while the executor is leased.

## Warm-pool isolation

Warm sandboxes are reset before reuse. v0.6 adds an optional post-reset proof; failed verification destroys the sandbox instead of returning it to the pool.

## Effect policy

`PolicyEffectGate` separates model intent from privileged action. Durable effect receipts additionally prevent accidental duplicate execution after transport/workflow retries.


## v0.6 multi-process persistence boundary

The production control plane can now place all canonical runtime receipts behind one Postgres adapter:

```text
AgentRuntime ───────────────┐
ExecutionBroker ────────────┼──> PostgresPersistence ──> PostgreSQL
Project/World ──────────────┘
```

`claimCommand()` and `claimEffect()` are the important concurrency additions. They let two workers share the same runtime store without both taking ownership of one logical side effect.

The chaos layer sits outside these interfaces rather than inside business logic, so the same failpoint plan can wrap local stores, Postgres-backed stores, executors, or inference gateways.

## v0.6 verification boundaries

The architecture now distinguishes three evidence levels:

```text
unit/contract in this package
  ├ real Node HTTP server
  └ real child-process SIGKILL

installable external contract
  └ Pi AgentHarness + MemoryExecutionEnv

live infrastructure contract
  ├ PostgreSQL multi-connection contention
  └ Kubernetes forced Pod deletion
```

Only the first category is reported as executed in the artifact build environment. This separation is intentional: a test source file for Kubernetes is not evidence that a Kubernetes cluster passed it.
