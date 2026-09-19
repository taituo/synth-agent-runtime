# OpenClaw integration seam

OpenClaw's custom provider config can route inference to the Synth bridge without
a source patch. Tool execution needs one narrow seam after OpenClaw has already
applied schema normalization, before_tool_call policy/approval, and abort
wrappers.

In `src/agents/agent-tools.finalize.ts`, apply the bridge wrapper to
`withAbort` immediately before `applyToolAvailabilityDescriptions`:

```ts
const withTemporal =
  temporalToolBridge
    ? wrapFinalizedOpenClawTools(temporalToolBridge, withAbort, options.hookContext)
    : withAbort;
const finalized = applyToolAvailabilityDescriptions(withTemporal);
```

The important ordering is:

```text
source tool
 -> before_tool_call + approval
 -> abort/source authority wrapper
 -> Temporal bridge wrapper
 -> original tool.execute (only from loopback callback)
```

Do not put the Temporal wrapper before OpenClaw's policy wrappers: the loopback
would otherwise bypass or duplicate policy decisions.

The bridge keeps the exact original `AnyAgentTool.execute` closure in a pending
map keyed by OpenClaw's stable `toolCallId`. Temporal receives only serializable
identity/arguments. When the activity calls the local `/execute` endpoint, the
adapter invokes the already-authorized original closure with its original
AbortSignal and progress callback.

Inference config is ordinary OpenClaw custom-provider config:

```json5
{
  models: {
    providers: {
      synth: {
        baseUrl: "http://127.0.0.1:8788/v1",
        api: "openai-completions",
        apiKey: "bridge-token",
        models: [{
          id: "coding/strong",
          name: "Synth coding/strong",
          reasoning: true,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 32000,
          compat: { supportsTools: true }
        }]
      }
    }
  }
}
```

`seam.ts` contains that identity mapping directly: it requires `agentId` and
uses `sessionId` (or `sessionKey` as the fallback), and exposes
`createOpenClawTemporalBridgeFromEnv()`. Start that bridge once per Gateway
process and use `wrapFinalizedOpenClawTools(..., options.hookContext)` per
prepared turn.


For callback authentication, pass the same secret to the Temporal worker as
`SYNTH_TOOL_CALLBACK_TOKEN` and to `OpenClawTemporalToolBridge` as
`callbackBearerToken`. If the worker is remote, set `callbackUrl` to a
worker-routable URL and add that exact origin to
`SYNTH_TOOL_CALLBACK_ORIGINS`.

The wrapper is implemented with a Proxy rather than object spread so OpenClaw
tool symbols, non-enumerable metadata and wrapped authority/cancellation
properties survive the extra dispatch layer.
