# Hermes ↔ Synth Temporal bridge

This adapter deliberately leaves Hermes' agent loop, session store, prompt
assembly, compression and agent-local state tools in Hermes.

## Inference

Point Hermes at the Synth bridge as a custom OpenAI-compatible provider:

```yaml
model:
  provider: custom
  base_url: http://127.0.0.1:8788/v1
  api_mode: chat_completions
  default: coding/strong
```

The bridge accepts `/v1/chat/completions` and `/v1/responses`, starts one
Temporal workflow per stable inference call id, and the Temporal activity calls
the configured real inference backend.

For stable dedupe/correlation, supply `x-synth-agent-id`,
`x-synth-session-id`, and `x-synth-call-id` from the Hermes HTTP client
when integrating this beyond the prototype. Without them the bridge generates a
new call id.

## Tools

Load `hermes_temporal_bridge.install_from_env()` during Hermes startup. It
patches both `model_tools.handle_function_call` and the symbol imported by
`run_agent.py`.

Registry/effect tools then take this path:

```text
Hermes tool loop
  -> Synth bridge POST /v1/synth/tools/execute
  -> Temporal harnessToolWorkflow
  -> forwardToolExecution activity
  -> Hermes loopback /execute
  -> original handle_function_call
```

The callback exists so the original Hermes tool implementation, environment,
plugin hooks, and task/session context stay authoritative. The adapter does not
copy Hermes tools into Synth.

Agent-local `todo`, `memory`, `session_search`, `clarify`, and
`delegate_task` remain local by design. They mutate Hermes' own control state
or require in-process callbacks rather than representing a portable external
effect.

Temporal automatic retries are disabled for tool activities. A lost callback
response may mean the effect already happened, so replay must be decided by the
tool/effect owner rather than blindly by Temporal.


## Callback authentication

Set the same callback token on the worker and Hermes:

```bash
export SYNTH_TOOL_CALLBACK_TOKEN=local-callback-secret
export SYNTH_HERMES_CALLBACK_URL=http://127.0.0.1:8791/execute
```

The Temporal worker sends this token to the harness callback and the Hermes
listener rejects mismatches. In distributed deployments the callback URL must
be routable from the worker and its origin must be present in
`SYNTH_TOOL_CALLBACK_ORIGINS`.
