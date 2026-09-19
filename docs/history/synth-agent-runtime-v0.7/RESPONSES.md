# Responses API compatibility

v0.7 provides a coding-agent-oriented Responses transport for Pi, OpenCode Desktop/TUI, and other clients while routing inference through the stacked provider/account layer underneath.

## Request surface

The bundled Pi/OpenCode adapter supports the coding-relevant subset:

- `model`;
- `input` as string or message/function-call-oriented item arrays;
- `instructions`;
- function `tools` and `tool_choice`;
- `max_output_tokens`;
- supported reasoning effort values;
- `stream`;
- `store`;
- `previous_response_id` through the adapter's bounded local continuation cache;
- `metadata.session_id` and session headers for routing affinity.

The gateway does not prepend its own model-facing system prompt. Prompt/tool context comes from the client/runtime integration.

## Streaming surface

`ResponsesStreamEncoder` emits the coding-relevant event families implemented by this package:

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.reasoning_summary_part.added
response.reasoning_summary_text.delta
response.reasoning_summary_text.done
response.reasoning_summary_part.done
response.function_call_arguments.delta
response.function_call_arguments.done
response.output_item.done
response.completed
response.incomplete
response.failed
```

Pi thinking events map to reasoning-summary events; Pi tool-call deltas map to function-call argument deltas. Usage can carry cached-input and reasoning-token detail when the model provider exposes it.

## Continuation semantics

The adapter stores translated Pi context by response ID in a bounded in-memory cache (`maxStoredResponses`, default 1000). A follow-up request can refer to that ID with `previous_response_id`.

The previous request's instructions are not implicitly reused as the new request's instructions. The new request supplies its own current `instructions`; earlier transcript content is replayed as continuation context.

The cache remains process-local. A gateway restart or another replica cannot resolve those IDs. Shared/durable response context is an explicit v0.8 item in `CODE-REVIEW.md`.

## Cancellation and transport

The request `AbortSignal` is forwarded into Pi/model streaming. Downstream disconnects cancel the backend stream, and retryable upstream bodies are cancelled before the router attempts another route.

## Deliberate non-goals

This is not a claim to implement every optional Responses feature. It does not claim full fidelity for hosted web/file/computer tools, background jobs, server conversations, prompt templates, every multimodal item family, or encrypted/provider-specific reasoning items.

Add those only when a real client/provider contract requires them; avoid inventing lossy synthetic behavior.
