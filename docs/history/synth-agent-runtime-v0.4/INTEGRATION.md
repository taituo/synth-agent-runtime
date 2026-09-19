# Integration map v0.4

## Pi

The current Pi seam remains `ExecutionEnv` plus `AgentHarness`/lane. Session persistence and agent-visible workspace execution stay separate:

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

The next integration step is to bind Pi output/tool events to `DurableTurn`, so provider fallback and workspace rollback share one commit boundary.

## OpenCode subscription stack and gateway

```text
OpenCode Desktop/TUI
Pi
other OpenAI client
       │
       ▼
/v1/chat/completions or /v1/responses
       │
ProfileRouterBackend
  session affinity / cooldown
       │
OpenCodeStackGatewayBackend
       │
OpenCodeStackModels
  A / B / C / fallbacks
```

The router does not inject a second system prompt.

## Runtime recovery

A production bootstrap should open the durable stores, construct `AgentRuntime`, then call `recover()` before accepting new commands:

```ts
const runtime = new AgentRuntime(durability, broker, new Map(), runtimeState)
await runtime.recover({ definition: loadDefinition, engine: createPiEngine, workspace: loadWorkspace })
```

## Kubernetes

Physical `process.exec` effects flow through `ExecutionBroker`. Kubernetes leases a gVisor Pod, materializes the visible workspace, executes, syncs changes back, resets the Pod, verifies reset, then either returns it to the pool or destroys it.

## Temporal

Temporal remains outside the public runtime model. Workflow retries should pass stable command/effect IDs into runtime operations so `RuntimeStateStore` can deduplicate/reconcile them.

## Project world

`WorldStore` remains independent from runtime recovery state. Production should back both `WorldStore` and `RuntimeStateStore` with transactional storage, ideally in the same database when cross-record consistency is required.
