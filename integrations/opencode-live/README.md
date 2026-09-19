# Live OpenAI-compatible gateway probe

This probe is deliberately provider-agnostic. Point it at a deployed synth gateway
whose backend is the OpenCode/Pi stack router. It verifies discovery and one streamed
`/v1/responses` turn without changing the prompt or tool layer.

```bash
export SYNTH_GATEWAY_URL=http://127.0.0.1:8787
export SYNTH_GATEWAY_MODEL=worker/cheap   # optional; first model is used otherwise
export SYNTH_SESSION_ID=smoke-1           # optional
node integrations/opencode-live/probe.mjs
```

If your front door requires a bearer token, set `SYNTH_GATEWAY_BEARER`.
