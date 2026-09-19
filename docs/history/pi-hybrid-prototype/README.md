# Pi + OpenCode Go hybrid inference prototype

This is the inference-side companion to the synthetic-environment prototype.

## Key finding

Current Pi already has a built-in `opencode-go` provider. You do **not** need to copy OpenCode provider code into Pi just to use an OpenCode Go subscription.

Pi accepts an OpenCode API key via `OPENCODE_API_KEY` or its auth store, exposes `opencode-go` as a provider, and current OpenCode Go documentation lists Pi as a validated client. Pi also carries a stable OpenCode session header on current builds.

Basic direct use is therefore conceptually:

```bash
export OPENCODE_API_KEY='...'
pi --provider opencode-go --model '<model-id>'
```

Use the model picker / list command to select an actual model ID from the current catalog.

## Why add a router anyway?

The router is for the larger agent topology:

```text
Super instance       -> profile: super
Worker instance      -> profile: worker-cheap
Reviewer instance    -> profile: reviewer
Summarizer instance  -> profile: summarizer
```

Each profile is an ordered route list. Pi continues to own provider catalogs, auth, OpenCode Go request formatting, and provider-specific API behavior. `RoutingModels` only chooses which existing Pi `Model` receives a request.

```text
AgentHarness
   |
   v
RoutingModels                  <- ours
   |
   +--> Pi ModelRuntime        <- upstream Pi
           |
           +--> opencode-go
           +--> openai
           +--> anthropic
           +--> openrouter
           +--> ...
```

## Fallback semantics in this prototype

Fallback is intentionally conservative.

A request may switch to another route only **before semantic model output has been exposed**. A provider can fail during setup or immediately after `start`; the router suppresses that failed `start` and tries the next route. Once text, thinking, a tool call, or a completed response is emitted, that route is committed for the request.

This avoids silently replaying tool-producing model output against another provider.

Later, the synthetic workspace can make stronger fallback possible: snapshot the world at turn start, and on a failed half-turn roll back the world before replaying the turn with another route.

## OpenCode Go session identity

OpenCode Go expects a stable per-conversation session identity. `RoutingModels` accepts a `sessionId` and injects it into Pi's stream options when the caller did not already provide one. Pi's OpenCode Go provider then supplies the OpenCode session header.

## Multiple subscriptions / accounts

The routing layer is intentionally provider/profile based. It can later support provider aliases with separate credentials, but the prototype does **not** assume that aggregating multiple OpenCode Go subscriptions for one operator is allowed. Keep account-pooling policy separate from the runtime and follow the provider's current terms.

## Integration with the synthetic worker

The target wiring is:

```ts
const { base, models } = await createHybridModels({
  profile: workerProfile,
  sessionId,
  openCodeGoApiKey: process.env.OPENCODE_API_KEY,
});

const { harness } = await AgentHarness.create({
  session,
  models,
  model: base.getModel(primary.provider, primary.model)!,
  tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
  toolContext: { env: memoryExecutionEnv },
  systemPrompt,
}, context);
```

So the two experiments remain orthogonal:

```text
inference: Pi ModelRuntime -> RoutingModels -> OpenCode Go / APIs
execution: Pi tools -> MemoryExecutionEnv
```

That is the clean hybrid boundary.
