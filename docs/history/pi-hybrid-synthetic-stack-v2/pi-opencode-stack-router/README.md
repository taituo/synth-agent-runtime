# Transparent OpenCode Go subscription stack for Pi

This layer makes several separately authorized OpenCode Go API keys look like one ordinary `opencode-go` provider to Pi's `AgentHarness`.

```text
Pi AgentHarness
      |
      | ordinary Models API
      v
OpenCodeStackModels
      |
      +-- OpenCode Go account A -- Pi ModelRuntime -- opencode-go
      +-- OpenCode Go account B -- Pi ModelRuntime -- opencode-go
      +-- OpenCode Go account C -- Pi ModelRuntime -- opencode-go
      |
      +-- normal Pi ModelRuntime
             +-- OpenRouter
             +-- Anthropic
             +-- OpenAI
             +-- OpenCode Zen
             +-- anything else you configure normally
```

The Pi agent still selects a normal model such as:

```ts
models.getModel("opencode-go", "kimi-k2.7-code")
```

It does not know which OpenCode subscription services the request.

## Why one ModelRuntime per OpenCode subscription?

Pi's provider id is `opencode-go` and a normal `ModelRuntime` has one effective credential for a provider. Instead of inventing fake provider ids or modifying Pi's provider implementation, this router creates one isolated Pi `ModelRuntime` per OpenCode Go API key. Each runtime therefore uses upstream Pi's existing OpenCode request formatting, model catalog, session header behavior, and provider compatibility code unchanged.

The normal/manual Pi runtime stays separate and continues to read whatever providers you configure in Pi via `auth.json`, environment variables, OAuth, or `models.json`.

## Configuration

Never put keys in source if you can avoid it.

```bash
export OPENCODE_GO_KEY_A='...'
export OPENCODE_GO_KEY_B='...'
export PI_OPENCODE_GO_STACK='go-a:OPENCODE_GO_KEY_A,go-b:OPENCODE_GO_KEY_B'
```

```ts
import { createTransparentModels, openCodeGoAccountsFromEnv } from "./src/inference/index.js";

const { models } = await createTransparentModels({
  sessionId: "agent-42",
  config: {
    openCodeGo: {
      strategy: "sticky-least-loaded",
      accounts: openCodeGoAccountsFromEnv(),
    },
    fallbacks: [
      { id: "zen", provider: "opencode", model: "$requested" },
      { id: "openrouter", provider: "openrouter", model: "qwen/qwen3-coder" },
    ],
  },
});
```

The fallback providers are intentionally not special. Configure those with normal Pi mechanisms.

## AgentHarness integration

```ts
const model = models.getModel("opencode-go", "kimi-k2.7-code");
if (!model) throw new Error("model not found");

const { harness } = await AgentHarness.create({
  session,
  models,
  model,
  tools,
  toolContext,
  systemPrompt,
}, context);
```

There is no account id in the agent configuration.

## Routing behavior

`sticky-least-loaded` is the default and is designed for long-running agents:

1. A logical session stays on its last successful OpenCode account while that account is healthy. This preserves provider/session affinity.
2. A new session chooses the healthy account with the fewest in-flight requests, then the least recently used account.
3. If that account fails before semantic output is exposed, the same turn is attempted on the next healthy account.
4. Quota/rate-limit/provider failures put only that account into cooldown.
5. If every OpenCode account is unavailable, configured manual fallback routes are attempted.

`ordered` and `round-robin` are also supported.

## Safe failover rule

The router buffers only the provider `start` event. It may switch account/provider only before text, thinking, a tool call, or a completed response has been emitted. Once semantic output is visible, the request is committed and is not silently replayed.

That conservative rule can later be relaxed for the synthetic in-memory machine by snapshotting the machine at turn start and rolling back tool effects before replay.

## OpenCode usage-limit handling

The router recognizes Pi/OpenCode terminal limit errors such as `GoUsageLimitError`, usage/quota failures, 429s, timeouts and 5xx failures. It also observes provider response headers through Pi's `onResponse` callback and honors `Retry-After`/common rate-limit reset headers when present.

Without a reset header, a Go usage-limit error defaults to a 5-hour cooldown. This is configurable. It is deliberately account-local: other authorized accounts remain available.

## Introspection

```ts
console.log(models.inspect());
```

returns health and cooldown metadata without exposing API keys:

```text
accounts:
  go-a healthy, inFlight=2
  go-b cooldownUntil=...

stickySessions:
  agent-42 -> go-a
```

## Credential boundary

Only use API keys/subscriptions you are authorized to use. The router does not create accounts, share credentials, alter provider limits, or attempt to evade provider enforcement. It simply treats separately configured credentials as independent inference capacity and applies ordinary failover among them.
