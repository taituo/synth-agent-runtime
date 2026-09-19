# Responses API compatibility

v0.6 adds a Responses transport specifically for coding-agent clients. The goal is a transparent normal provider surface for Pi, OpenCode Desktop/TUI, and other clients while routing to the stacked inference layer underneath.

## Request surface

The bundled Pi/OpenCode adapter supports:

- `model`;
- `input` as a string or message/function-call item array;
- `instructions`;
- function `tools`;
- `tool_choice` (`none` vs automatic routing);
- `max_output_tokens`;
- supported reasoning effort values;
- `stream`;
- `store`;
- `previous_response_id` using the adapter's bounded local continuation cache;
- session affinity from `x-synth-session`, `x-session-id`, or `x-opencode-session`.

The gateway itself does not inject a system prompt. `instructions`, system/developer messages, tools, and transcript items originate from the client.

## Streaming surface

`ResponsesStreamEncoder` emits the coding-relevant event families:

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.function_call_arguments.delta
response.function_call_arguments.done
response.output_item.done
response.completed
response.failed
```

Pi `toolcall_delta` events are forwarded as function argument deltas instead of waiting for the complete tool call.

## Continuation

The optional local continuation cache is deliberately bounded (`maxStoredResponses`, default 1000). It stores translated Pi context by response ID so a subsequent request can use `previous_response_id` without requiring the upstream provider to implement server-side state.

This cache is process-local. Production multi-process deployments should move response continuation into a shared durable session/transcript store or avoid relying on `previous_response_id` across gateway instances.

## Deliberate non-goals in v0.6

This is not a complete implementation of every optional Responses capability. The following are not claimed:

- hosted web/file/computer tools at the gateway layer;
- background/deferred Responses jobs;
- server conversations/resources;
- stored prompt templates;
- every multimodal input/output item type;
- encrypted reasoning item fidelity across arbitrary providers.

Those should be added only when a client or routed provider needs them, rather than inventing lossy translations prematurely.
