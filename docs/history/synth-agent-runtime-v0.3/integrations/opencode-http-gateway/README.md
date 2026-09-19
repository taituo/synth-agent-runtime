# OpenCode stack → HTTP gateway bridge

This optional adapter exposes the existing `OpenCodeStackModels` pool as a normal OpenAI-compatible backend for the v0.3 inference gateway.

The intended composition is:

```text
OpenCode Desktop / Pi / other clients
              │
       /v1/chat/completions
              │
       synth inference gateway
              │
  OpenCodeStackGatewayBackend
              │
       OpenCodeStackModels
         ├ Go account A
         ├ Go account B
         └ Go account C
```

The bridge deliberately does **not** add a system prompt. It translates the client's request into Pi's normalized context and forwards the system/developer content, messages and tool declarations supplied by the client. The account stack remains responsible only for account/provider selection.

v0.3 implements OpenAI Chat Completions, including streaming text and completed tool calls. `/v1/responses` stays disabled for this specific Pi adapter until a lossless Responses translation is added; the generic gateway itself still accepts Responses backends that implement it.
