# Integration map

The bundle contains three layers:

1. `src/` — new runtime core: agents, tasks, relations, workspace, execution broker, durability boundary, gateway shell.
2. `integrations/pi-synthetic-git-prototype/` — the earlier Pi `ExecutionEnv` implementation that keeps the agent-visible machine in memory.
3. `integrations/pi-opencode-stack-router/` — the earlier Pi `Models` router that stacks multiple OpenCode Go accounts and then uses ordinary configured fallbacks.

## Immediate merge target

In a Pi checkout:

```text
Pi AgentSession
   |
   +-- tools --------------------> MemoryExecutionEnv
   |                                lazy Git base + RAM overlay
   |
   +-- stream/model runtime -----> OpenCodeStackModels
                                    Go A -> Go B -> Go C -> manual fallback
```

Then wrap the resulting Pi session with `PiAgentEngine` and let `AgentRuntime` own lifecycle, task graph, attach/detach, relations and durability.

## Gateway target

Turn `OpenCodeStackModels` into one `GatewayBackend` behind `createInferenceGateway()`.

That gives every client one endpoint:

```text
OpenCode Desktop/TUI ----\
Pi -----------------------+--> http://router:8787/v1
Temporal workers --------/
```

Logical models can then be stable names such as:

```text
worker/cheap
super/strong
reviewer/independent
```

The gateway maps those profiles onto the OpenCode subscription pool and any manually configured providers.
