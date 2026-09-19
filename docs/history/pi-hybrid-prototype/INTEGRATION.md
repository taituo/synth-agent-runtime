# Integration plan into the Pi synthetic runtime

## Minimal upstream fork changes

For the first experiment, do not modify OpenCode and do not modify Pi's `opencode-go` provider.

Use Pi's current provider implementation as-is. Add the router as a small package/module in the prototype and inject it where `AgentHarness.create()` receives `models`.

The experimental mini worker currently does roughly:

```ts
const modelRuntime = await ModelRuntime.create();
const executionEnv = new NodeExecutionEnv({ cwd });

await AgentHarness.create({
  models: modelRuntime,
  model,
  tools,
  toolContext: { env: executionEnv },
  ...
});
```

Change the conceptual wiring to:

```ts
const modelRuntime = await ModelRuntime.create();
const models = new RoutingModels(modelRuntime, profile, { sessionId });
const executionEnv = MemoryExecutionEnv.fromSeed(seed);

await AgentHarness.create({
  models,
  model,
  tools,
  toolContext: { env: executionEnv },
  ...
});
```

This gives four independent knobs per agent instance:

1. task/session state
2. inference profile
3. synthetic workspace
4. interactive/unattended presentation

## Later Pi fork seam

If the prototype graduates into the regular `createAgentSession()` / TUI path, add an optional `models?: Models` or `modelsFactory` injection point to the coding-agent SDK rather than hard-wiring routing into every provider.

That keeps upstream Pi's provider implementation intact while allowing your runtime to supply a routed `Models` implementation.
