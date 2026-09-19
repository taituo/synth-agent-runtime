# Architecture v0.3

## Runtime layers

```text
Presentation
  OpenCode Desktop / TUI / voice / API
                │
                ▼
Control plane
  AgentRuntime ─ Project World ─ Supervisor
      │               │             │
      ├ durability    projections    └ agent/task/review graph
      │
      ├ inference profile ──> OpenAI-compatible gateway/router
      │
      └ workspace ──────────> ExecutionBroker
                                  ├ synthetic RAM
                                  ├ K8s/gVisor
                                  └ ProjectCell
```

Pi is an agent-loop adapter, not the whole platform. OpenCode can be either a normal client/agent using the inference gateway or a presentation client for runtime-owned Pi agents.

## First-class objects

`AgentInstance` carries identity, definition, task, workspace, inference profile, execution policy, mailbox, state and relations. `Task` carries objective/constraints/dependencies/status. `ProjectSpec` is canonical long-lived project state: objective, constraints, accepted decisions, task IDs and artifact IDs. `Workspace` carries immutable source revision plus mutable RAM overlay. `Effect` is an execution request routed through policy and an executor.

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

The current `InMemoryWorldStore` proves the API; a durable database/Temporal-backed store can implement the same shape later.

## Workspace and Git

```text
bare shallow/partial Git object store
        │
        ▼
 NativeGitSource (immutable base)
        │
        ▼
 MemoryWorkspace
   ├ clean reads from base
   ├ writes in RAM
   ├ tombstones in RAM
   ├ snapshot/restore
   ├ fork
   └ diff artifact
```

Sparse visibility is a workspace/source policy. Shallow controls history depth. Partial clone controls object hydration. They are separate dimensions.

## Transaction boundary

A workspace snapshot is now restorable. `WorkspaceTransaction` and `runTransactionalTurn()` allow provider retries to roll back tool-side RAM mutations before another provider/account attempt.

The caller must only mark an attempt retryable while semantic output remains uncommitted. Physical side effects require their own compensation/transaction policy and are not automatically reversible.

## Supervisor graph

Roles are relations, not species:

```text
supervises
 delegates_to
 consults
 reviews
 reports_to
 shares_resource
```

`Supervisor.delegate()` creates a task, forks the parent workspace, spawns a child and writes graph relations. `fanOut()` creates multiple independent workers; `assignReviewer()` adds a review edge without changing the underlying agent type.

## Inference

```text
client model = worker/cheap
          │
          ▼
ProfileRouterBackend
  route 1: opencode-stack / kimi...
  route 2: manual OpenRouter / ...
  route 3: other OpenAI-compatible backend
```

Routing may select accounts/providers/models, but it does not rewrite client prompts. Virtual model names stay stable while infrastructure changes underneath.

## Execution fidelity ladder

```text
L0 MemoryExecutionEnv / synthetic
  ↓ unsupported physical command
L1 sandbox-small gVisor
  ↓ larger build
L2 sandbox-medium/heavy gVisor
  ↓ reusable services
L3 ProjectCell
  ↓ stronger VM isolation (future)
L4 Firecracker/Kata
  ↓ staging / production reality
```

The workspace identity remains stable during promotion; the executor is leased.

## Durability

The root runtime exposes `DurabilityProvider` and stays Temporal-neutral. `integrations/temporal/` demonstrates the deployment pattern where a Temporal workflow owns lifecycle/mailbox state and activities perform Pi/model/Kubernetes work in normal worker processes.

## Effect policy

`PolicyEffectGate` separates model intent from privileged action. Effects may be allowlisted, denied or routed to a human approval callback before execution. The agent sandbox never receives Kubernetes control-plane credentials merely because it requested a deploy or physical execution.
