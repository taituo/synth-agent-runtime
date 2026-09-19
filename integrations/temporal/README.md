# Temporal integration

The bundle includes a real Temporal workflow/client/worker integration as an **optional package**, while keeping the public runtime API Temporal-neutral.

The original integration owns a durable logical agent loop:

```text
AgentRuntime API
      │
      ├ local mode → LocalMemoryDurability
      │
      └ durable deployment
             │
       Temporal workflow
       lifecycle + mailbox
             │
       runTurn activity
             │
         Pi / tools / K8s
```

The workflow owns durable lifecycle/mailbox state and signals. Model calls, Pi harness work and Kubernetes execution remain activities in normal Node worker processes, where network/filesystem access is allowed.

## Harness I/O bridge

The package also contains a second, deliberately separate mode for external agent
harnesses such as Hermes and OpenClaw. In this mode the harness keeps its own
agent loop and Temporal only durably transports concrete inference/tool
operations:

```text
Hermes / OpenClaw
   │
   ├ inference ─→ bridge HTTP ─→ harnessInferenceWorkflow ─→ model activity
   │
   └ tool call ─→ bridge HTTP ─→ harnessToolWorkflow ─→ harness callback
```

This is not the Gym and does not replace `durableAgentWorkflow`.

Tool activities have `maximumAttempts: 1` because a callback can perform an
external side effect before its response is lost. Blind Temporal retry would be
unsafe. Stable `toolCallId` workflow ids instead make duplicate submissions
join the same durable operation; uncertain external effects still need
Synth/owner-level receipt/reconciliation semantics.

Inference responses are currently buffered until the activity completes. That
keeps semantic exposure behind a durable completion boundary, but means this
first bridge does not provide live token streaming.

### Run the bridge service

```bash
cd integrations/temporal
npm ci
npm run build

export TEMPORAL_ADDRESS=127.0.0.1:7233
export SYNTH_INFERENCE_UPSTREAM_URL=https://your-openai-compatible-backend.example
export SYNTH_INFERENCE_UPSTREAM_API_KEY=...
export SYNTH_TOOL_CALLBACK_ORIGINS=http://127.0.0.1:8791,http://127.0.0.1:8792
export SYNTH_BRIDGE_TOKEN=dev-bridge-token
npm run bridge:service
```

`SYNTH_TOOL_CALLBACK_ORIGINS` is an exact allowlist enforced by the Temporal
worker before it performs callback I/O. In distributed deployments the harness
must advertise a callback URL reachable from the worker rather than a loopback
URL.

The optional integration has its own `package.json` because the root runtime intentionally has no hard Temporal SDK dependency.
