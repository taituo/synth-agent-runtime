# Inference gateway and routing

The gateway is a normal OpenAI-compatible front door with stable logical model IDs.

```text
OpenCode / Pi / other client
           │
           ▼
  /v1/chat/completions
       /v1/responses
           │
           ▼
 ProfileRouterBackend
   ├ OpenCode account stack
   ├ OpenRouter/manual route
   └ other compatible upstream
```

## Routing

`ProfileRouterBackend` provides ordered fallback, route cooldowns, `Retry-After`, and session affinity via `x-synth-session` / `x-opencode-session`. It only retries before a successful response has escaped the network boundary.

Workspace/model semantic replay belongs inside `DurableTurn`, not in a blind HTTP proxy.

## v0.6 Responses transport

The Pi/OpenCode-stack backend now supports both Chat Completions and the coding-agent Responses surface. It forwards text deltas and Pi tool-call argument deltas, usage, max token settings, supported reasoning effort, and cancellation.

`previous_response_id` can be resolved from a bounded process-local context cache. This makes a single gateway instance convenient for clients that use Responses continuation, but it is not yet a shared multi-replica response store.

See `RESPONSES.md` for the exact supported surface and non-goals.

## Prompt transparency

The gateway does **not** prepend a coding-agent prompt. Whatever system/developer instructions and tool declarations reach the routed model came from the client transcript or client agent runtime.

If OpenCode owns the agent loop, OpenCode's own agent semantics are naturally present because OpenCode sent them. If our Pi runtime owns the agent loop, only our Pi/runtime prompt and tools are present.
