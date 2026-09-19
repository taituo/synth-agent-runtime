# OpenCode stack HTTP gateway adapter

`adapter.ts` exposes a Pi `Models` runtime (including the transparent OpenCode Go account stack) as an ordinary `GatewayBackend`.

Supported front-door paths in v0.7:

```text
/v1/chat/completions
/v1/responses
```

The adapter does **not** add a system prompt. It translates the client's transcript/tools into Pi types and delegates inference to the supplied `Models` object.

Responses streaming forwards text deltas and function-call argument deltas. A bounded local response-context cache provides `previous_response_id` continuation for one gateway process. Set `maxStoredResponses: 0` to disable it.

For multiple gateway replicas, replace process-local continuation with a shared durable transcript/response store before depending on response IDs across replicas.
