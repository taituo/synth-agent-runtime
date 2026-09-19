# Synth Agent Runtime v0.2

v0.2 extends the Pi/OpenCode synthetic-agent core with a concrete physical execution layer for Kubernetes/gVisor.

```text
User / TUI / Desktop / Voice
            |
         AgentRuntime
       /      |       \
 Agent graph  Tasks   Durable world
      |                 |
   Pi adapter         Temporal adapter
      |
 MemoryWorkspace ---------------- ExecutionBroker
      |                              |
 native Git base        synthetic -> K8s/gVisor -> ProjectCell
      |
 Inference profiles -> OpenAI-compatible gateway -> OpenCode stack / manual providers
```

## Implemented

- `AgentRuntime`: same logical agent works attached/interactively or unattended.
- Agent/task/relation/artifact primitives.
- `ExecutionPolicy` on agent definitions.
- RAM-only mutable `MemoryWorkspace`, cheap `fork()`, diff artifacts.
- Checkout-less `NativeGitSource`: bare + shallow + partial (`blob:none`) backing source with sparse view.
- `ExecutionBroker` with resource-class preference, allowlists and escalation policy.
- deterministic/synthetic execution boundary.
- Kubernetes resource classes: `sandbox-small`, `sandbox-medium`, `sandbox-heavy`, `project-cell`.
- hardened Pod + NetworkPolicy generation.
- concrete `KubectlSandboxBackend` (no Kubernetes npm dependency).
- bounded reusable `WarmSandboxPool`.
- `WorkspaceSynchronizer`: trusted sparse source -> physical sandbox -> changed files back to RAM.
- `KubernetesExecutor` implementing `process.exec` effects.
- `ProjectCellManager` for longer-lived isolated executor + service groups.
- local durability + Temporal adapter boundary.
- Pi engine adapter boundary.
- OpenAI-compatible inference gateway shell.
- previous OpenCode Go account-stack and Pi synthetic Git integrations bundled under `integrations/`.

## Execution model

A logical agent is not a Pod. Kubernetes resources are leased only when an effect requires physical fidelity:

```text
AgentInstance (durable)
     |
     | read/edit/search
     v
MemoryWorkspace
     |
     | process.exec unsupported synthetically
     v
ExecutionBroker
     |
     +--> warm sandbox-small (gVisor)
     +--> sandbox-medium
     +--> sandbox-heavy
     `--> ProjectCell
```

Example policy:

```ts
{
  preferredClass: "sandbox-small",
  allowedClasses: ["sandbox-small", "sandbox-medium", "sandbox-heavy"],
  allowEscalation: true,
}
```

A physical sandbox gets the visible sparse source plus the current RAM overlay. Repository credentials remain in the trusted control plane by default. After execution, changed source files are merged back into the same `MemoryWorkspace`.

## Kubernetes isolation defaults

Generated executor Pods use:

- gVisor `runtimeClassName: gvisor`
- non-root UID/GID
- `automountServiceAccountToken: false`
- `allowPrivilegeEscalation: false`
- `privileged: false`
- drop `ALL` Linux capabilities
- `RuntimeDefault` seccomp
- read-only root filesystem
- separate ephemeral `/workspace` and `/tmp`
- CPU/memory/ephemeral-storage requests and limits
- active deadline
- per-Pod NetworkPolicy
- DNS + explicit egress proxy for normal sandbox classes; no direct `0.0.0.0/0` rule

The trusted control plane owns Kubernetes credentials. The agent container does not.

## Git model

```text
shared bare partial clone
  --depth=1
  --filter=blob:none
       |
       v
 NativeGitSource
       |
       v
 MemoryWorkspace
   RAM overlay
       |
       | only when physical execution is needed
       v
 WorkspaceSynchronizer
       |
       v
 isolated K8s / gVisor workspace
```

The backing object cache may live on disk/tmpfs. Mutable agent changes stay in RAM until explicitly materialized into a physical executor or exported as an artifact.

## Build / test

```bash
npm run build
npm test
npm run demo
npm run gateway:demo
```

The Kubernetes demo actually requires a configured cluster and executor image:

```bash
export SYNTH_EXECUTOR_IMAGE=registry.example/synth-executor:0.2.0
npm run k8s:demo
```

See `deploy/kubernetes/README.md`.
