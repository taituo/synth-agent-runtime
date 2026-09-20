# Pi runtime bridge

This bridge is the concrete seam between `AgentRuntime` and Pi's current `AgentHarness`.

The critical split is preserved:

```text
trusted session persistence       agent-visible workspace
NodeExecutionEnv                  MemoryExecutionEnv / Kubernetes escalation
        │                                     │
JsonlSessionRepo                        toolContext.env
        └──────────── AgentHarness ────────────┘
```

The bridge uses Pi's normal `read`, `write`, `edit` and `bash` harness tools. Synthetic execution is therefore an `ExecutionEnv` choice, not a second set of agent tools.

For the current Pi source layout, `AgentHarness.create()` receives `models`, `model`, `session`, tools and `toolContext: { env }`; the lane provides `prompt`, `steer`, `followUp` and `watch`. The included `harness-session.ts` wraps exactly that shape for `PiAgentEngine`.

Do not point Pi session JSONL at an ephemeral RAM workspace. Keep session storage in the trusted control plane and only swap the agent-visible `ExecutionEnv`.
