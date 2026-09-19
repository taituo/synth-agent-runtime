# Inference gateway and routing

The gateway is a normal OpenAI-compatible front door. Stable logical model IDs are mapped to ordered backend routes.

```text
OpenCode / Pi / other client
           │
           ▼
     logical model
           │
           ▼
ProfileRouterBackend
  ├ OpenCode Go account stack
  ├ OpenRouter/manual upstream
  └ other compatible backend
```

## v0.4 routing behavior

`ProfileRouterBackend` now provides:

- stable virtual model names;
- ordered fallback on pre-response retryable failures;
- `x-synth-session` and `x-opencode-session` route affinity;
- route cooldowns;
- `Retry-After` handling;
- affinity eviction when a sticky route becomes unhealthy.

The gateway never tries to restart a request after a successful streaming `Response` has already been returned. Mid-stream replay would require coordinating the model transcript, tool/effect state and workspace snapshot, so that belongs inside `DurableTurn` rather than at the blind HTTP proxy layer.

## OpenCode account stacking

Account stacking and logical routing remain separate:

```text
logical route
   │
   ▼
opencode-stack backend
   ├ account A
   ├ account B
   └ account C
```

The account stack picks equivalent credentials. `ProfileRouterBackend` chooses backend/model policy.

## Prompt transparency

The gateway does not prepend its own coding-agent system prompt. Client system/developer messages and tool declarations are forwarded/translated by the selected adapter. If OpenCode itself owns the agent loop, its own agent prompt/tool semantics are naturally still present because they originated at the client.

## Remaining adapter work

The generic front door accepts `/v1/chat/completions` and `/v1/responses`, but the bundled Pi/OpenCode-stack bridge is still Chat-Completions-first. A production Responses adapter should preserve streaming tool-call deltas, reasoning metadata, usage, abort semantics and provider response IDs without lossy translation.
