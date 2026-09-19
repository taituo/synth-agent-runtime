# Integration map v0.3

## Pi

The current Pi seam is `ExecutionEnv` plus `AgentHarness`/lane. Session persistence and agent-visible workspace execution remain separate:

```text
NodeExecutionEnv              MemoryExecutionEnv
 trusted session JSONL         synthetic project world
       │                             │
JsonlSessionRepo                  toolContext.env
       └────────── AgentHarness ─────┘
                    │
                  lane
          prompt / steer / watch
                    │
              PiAgentEngine
                    │
               AgentRuntime
```

`integrations/pi-runtime-bridge/harness-session.ts` wraps the current harness/lane shape for `PiAgentEngine`. The earlier full synthetic-Git patch remains in `integrations/pi-synthetic-git-prototype/`.

## OpenCode subscription stack and gateway

The existing `OpenCodeStackModels` keeps multiple independently authorized OpenCode Go accounts behind one Pi provider view. v0.3 adds a network boundary:

```text
OpenCode Desktop/TUI
Pi
other OpenAI client
       │
       ▼
/v1/chat/completions
       │
ProfileRouterBackend
       │
OpenCodeStackGatewayBackend
       │
OpenCodeStackModels
  A / B / C / fallbacks
```

The OpenCode bridge forwards client prompt/tool semantics rather than injecting a second agent prompt. It currently implements Chat Completions; generic gateway backends may implement Responses independently.

## Kubernetes

Synthetic tools operate against the RAM workspace first. A physical command becomes an `Effect(kind="process.exec")` and flows through `ExecutionBroker`. The Kubernetes executor leases a warm gVisor Pod, materializes the sparse visible workspace, executes, syncs bounded changes back to RAM, resets the Pod and returns it to the pool.

## Temporal

The optional integration uses a workflow for durable agent state and signals, with `runTurn` as an activity boundary:

```text
Temporal workflow
  state/mailbox/query/signal
        │
        ▼
runTurn activity
        │
        ├ Pi harness/model routing
        └ ExecutionBroker/Kubernetes
```

This avoids importing Temporal concepts into every runtime API.

## Project world

`InMemoryWorldStore` can be used beside `DurabilityProvider` today. A production implementation should persist ProjectSpec/Decision/Task/Artifact records in a durable database or via explicit Temporal activities. Agents receive projections, not unrestricted database state.

## Deployment shape

```text
synth-control-plane
├ runtime/API
├ inference gateway
├ Temporal client/worker
├ project-world store
└ egress/secret services

synth-sandboxes
└ bounded warm gVisor Pods

synth-cell-*
├ executor
└ optional postgres/redis/browser/services
```
