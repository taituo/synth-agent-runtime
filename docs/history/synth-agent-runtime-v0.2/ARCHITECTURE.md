# Architecture v0.2

## First-class runtime objects

```text
AgentInstance
  identity
  definition
  task
  workspace
  inference profile
  execution policy
  mailbox
  state
  relations

Task
  objective
  constraints
  dependencies
  owner/contributors
  status

Workspace
  immutable base revision
  sparse source view
  RAM overlay
  snapshots/forks
  artifacts

Effect
  workspace.read/write/delete/list
  process.exec
  workflow.run
  human.approval
```

## Fidelity ladder

```text
L0 synthetic RAM
  -> physical command required
L1 Kubernetes / gVisor small
  -> larger build/service need
L2 Kubernetes / gVisor medium/heavy
  -> long-lived project services
L3 ProjectCell
  -> stronger isolation / VM boundary (next)
L4 Firecracker / Kata (next)
  -> staging / reality
```

The workspace identity remains the same during promotion. Physical execution is a lease, not the agent's identity.

## Resource classes

`KubernetesResourceClass` owns CPU, memory, ephemeral storage, RuntimeClass, workspace medium, active deadline, networking, node placement and warm-pool policy.

Default classes are intentionally opinionated but replaceable:

```text
sandbox-small   250m request / 2 CPU limit / 4Gi memory
sandbox-medium  1 CPU request / 4 CPU limit / 8Gi memory
sandbox-heavy   2 CPU request / 8 CPU limit / 16Gi memory
project-cell    long-lived service-capable executor
```

Use production-specific images and pin them by digest.

## Physical execution transaction

```text
MemoryWorkspace
      |
      | sparse visible base + RAM diff
      v
WorkspaceSynchronizer
      |
      v
leased sandbox
      |
      +-- initialize local Git baseline
      +-- apply RAM overlay
      +-- execute command
      +-- inspect changed files
      `-- enforce sync file/byte limits
      |
      v
MemoryWorkspace updated
      |
      v
sandbox reset -> warm pool
```

If reset fails, the Pod is destroyed rather than reused.

## Security boundary

The Kubernetes API is a control-plane capability, never an agent capability.

```text
Agent process
  X no ServiceAccount token
  X no kubeconfig
  X no Docker socket
  X no hostPath
  X no privileged mode
      |
      v
Kubernetes/gVisor sandbox
      ^
      |
trusted Agent Runtime / KubectlSandboxBackend
```

Network access is explicit. Normal sandboxes get DNS and an egress-proxy path; ProjectCells get cell-local service communication plus DNS.

## ProjectCell

A ProjectCell is useful when repeated tasks require a real project environment:

```text
isolated namespace
├ executor (gVisor)
├ postgres
├ redis
├ browser
└ other project services
```

Agents lease the cell; they do not own its Kubernetes lifecycle. Idle cells are reaped by policy.

## Inference stays independent

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

Kubernetes executor selection and inference provider selection are independent dimensions.

## Next slice

1. Replace per-file `kubectl exec` transfer with framed tar/content-addressed blob transfer.
2. Native Git `cat-file --batch` source reader.
3. Complete Pi `MemoryExecutionEnv` adapter into `AgentRuntime.executeEffect()`.
4. OpenCode-stack `GatewayBackend` for the HTTP inference gateway.
5. Firecracker/Kata executor implementing the same `Executor` contract.
6. Persistent Project/Spec world and context projections.
7. Super agent: task decomposition, forks, reviews, merge selection.
