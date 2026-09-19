# Architecture / next slice

## First-class objects

```text
AgentInstance
  identity
  definition
  task
  workspace
  inference profile
  mailbox
  state
  relations
  budget (next)

Task
  objective
  constraints
  dependencies
  owner/contributors
  status

Workspace
  immutable base revision
  RAM overlay
  snapshots/forks
  artifacts

Effect
  read/write/delete/list
  process.exec
  workflow.run
  human.approval
```

## Execution ladder

```text
L0 synthetic RAM
  -> command unsupported / fidelity needed
L1 warm gVisor/Kubernetes
  -> stronger kernel/service requirement
L2 Firecracker
  -> integration validation
L3 staging/reality
```

The same workspace identity should survive promotion. A physical executor materializes only the base revision + overlay, executes, captures resulting changes/artifacts, and merges them back.

## Inference

Expose one ordinary OpenAI-compatible gateway:

```text
Pi / OpenCode Desktop / OpenCode TUI / workers
                     |
                     v
              /v1/* gateway
                     |
                logical model
       worker/cheap, super/strong, reviewer
                     |
                     v
             routing + account pool
         OpenCode Go A -> B -> C -> manual fallbacks
```

Keep account secrets and health inside the gateway. Clients should not know which subscription served a turn.

## Temporal

Do not expose Workflow/Activity/Signal concepts to agent code. Implement durability/control bindings beneath:

```text
AgentRuntime API
      |
DurabilityProvider
      |
TemporalProvider
```

Normal non-agent workflows can still use Temporal directly. Agents can invoke those workflows via typed `workflow.run` effects.

## Next code to add

1. Pi adapter using the existing `MemoryExecutionEnv` tool backend.
2. OpenCode-stack `GatewayBackend` converting `/v1/chat/completions` and `/v1/responses` into Pi Models calls.
3. Physical executor lease protocol: materialize -> run -> capture -> merge.
4. Native-Git batch reader (`cat-file --batch`) to remove per-file Git process startup.
5. Persistent world/project constraints and typed context projections.
6. Super agent that owns task decomposition and spawns/forks worker agents.
