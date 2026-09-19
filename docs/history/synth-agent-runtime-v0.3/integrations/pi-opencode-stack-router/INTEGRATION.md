# Integration into the synthetic Pi worker

The intended combined worker is:

```text
                       Pi AgentHarness
                         /          \
                        /            \
               Models/inference      tools/execution
                    |                     |
          OpenCodeStackModels       MemoryExecutionEnv
             /          \                 |
   OpenCode Go pool    manual          RAM overlay
      A / B / C       providers       + lazy Git base
```

In the synthetic mini worker, replace the single `ModelRuntime` passed to `AgentHarness.create()` with `OpenCodeStackModels` while leaving `MemoryExecutionEnv` unchanged.

```ts
const manual = await ModelRuntime.create();
const models = await OpenCodeStackModels.create({
  manualRuntime: manual,
  sessionId: session.metadata.id,
  config: routerConfig,
});

const model = models.getModel("opencode-go", "kimi-k2.7-code");
if (!model) throw new Error("OpenCode Go model not found");

await AgentHarness.create({
  session,
  models,
  model,
  tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
  toolContext: { env: memoryExecutionEnv },
  systemPrompt,
}, context);
```

Do not copy OpenCode's request code into the synthetic worker. Keep upstream Pi's `opencode-go` provider as the protocol implementation and put account selection above it.
