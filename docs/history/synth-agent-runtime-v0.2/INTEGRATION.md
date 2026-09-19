# Integration map v0.2

The bundle now has four cooperating layers.

```text
src/runtime + core
        |
        +-- inference gateway
        |
        +-- MemoryWorkspace / NativeGitSource
        |
        `-- ExecutionBroker
              |
              +-- SyntheticExecutor
              +-- KubernetesExecutor
              |     `-- WarmSandboxPool
              `-- ProjectCellManager
```

The earlier Pi integrations remain bundled:

```text
integrations/pi-synthetic-git-prototype/
integrations/pi-opencode-stack-router/
```

## Target Pi wiring

```text
Pi AgentSession / AgentHarness
   |
   +-- read/write/edit/bash ------> MemoryExecutionEnv
   |                                lazy Git + RAM overlay
   |
   +-- unsupported real command --> AgentRuntime.executeEffect(process.exec)
   |                                      |
   |                                      v
   |                                ExecutionBroker
   |                                synthetic -> K8s/gVisor
   |
   `-- model stream -------------> inference gateway / OpenCode stack
```

The important invariant is that a physical Pod is an execution lease. Pi session state, task state, workspace identity and durability remain outside the Pod.

## Recommended deployment shape

```text
synth-control-plane namespace
├ runtime/API
├ inference gateway
├ Temporal worker(s)
└ egress policy service

synth-sandboxes namespace
└ warm gVisor Pods (bounded pool)

synth-cell-* namespaces
├ executor
└ optional project services
```

Use a separate ServiceAccount/RBAC identity only for the trusted control plane. Executor Pods explicitly disable ServiceAccount token automount.

## Gateway target

Turn `OpenCodeStackModels` into a `GatewayBackend` so all clients use one ordinary provider endpoint:

```text
OpenCode Desktop/TUI ----\
Pi -----------------------+--> http://router:8787/v1
Temporal workers --------/
```

Logical model names remain stable while provider accounts and fallbacks remain private behind the gateway.
