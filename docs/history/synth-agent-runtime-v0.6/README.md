# Synth Agent Runtime v0.6

v0.6 turns the previous hardening work into **real-process and protocol contracts**. The runtime now has a crash-safe local durability provider, an actual `SIGKILL` recovery test, a Responses API coding-agent transport, a Pi `MemoryExecutionEnv` E2E installer, and live Postgres/Kubernetes contention/kill scripts for environments that provide those systems.

The central rule remains:

> A logical agent is durable state. Processes, provider connections, Kubernetes Pods, and model accounts are replaceable execution resources.

```text
OpenCode / Pi / Desktop / API
              │
              ▼
       OpenAI-compatible gateway
        ├ /v1/chat/completions
        └ /v1/responses
              │
        ProfileRouterBackend
        ├ OpenCode stack A/B/C
        └ manually configured providers
              │
              ▼
          Agent Runtime
      ┌───────┼───────────┐
      │       │           │
 Durable   Project     Durable turn
 state      world       boundary
      │                   │
      └──────────┬────────┘
                 ▼
        MemoryWorkspace + Git
                 │
          ExecutionBroker
          ├ synthetic
          ├ gVisor/Kubernetes
          └ ProjectCell
```

## v0.6 highlights

### Real process death contract

`test/process-crash.test.ts` launches a separate Node process, enters a persisted durable turn, modifies the RAM workspace, then the parent sends **SIGKILL**. A fresh `AgentRuntime` reopens file-backed durable state and proves that:

- the in-flight agent is reconstructed;
- `thinking` is normalized back to `idle`;
- the `started` turn is marked `rolled_back`;
- the pre-turn workspace snapshot is restored;
- uncommitted workspace mutation is absent.

This is materially stronger than throwing an exception inside one JS process.

### Crash-safe local durability

`JsonFileDurabilityProvider` complements `JsonFileRuntimeStateStore` for development/single-writer deployments. Both publish state using a temporary file plus same-directory rename. They are intentionally **single-writer** stores; multi-process production deployments should use `PostgresPersistence`.

### Responses API coding-agent surface

The gateway now includes `responses-protocol.ts`, which produces the Responses event families needed by coding clients:

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.function_call_arguments.delta
response.function_call_arguments.done
response.output_item.done
response.completed / response.failed
```

The bundled Pi/OpenCode adapter now accepts both `/v1/chat/completions` and `/v1/responses`, forwards streaming tool-call deltas, preserves usage, propagates session affinity, supports bounded local `previous_response_id` continuation, and does **not** add its own system prompt.

This is a coding-agent-compatible Responses subset, not a claim to implement every optional OpenAI Responses feature such as hosted tools, background jobs, conversations, prompt templates, or all multimodal item types.

### HTTP gateway contract

The root suite now starts the real Node HTTP gateway on an ephemeral port and verifies `/v1/models` plus streamed `/v1/responses`. Client disconnects propagate an `AbortSignal` into the backend request.

### Pi + MemoryExecutionEnv E2E installer

Two Pi contracts are bundled:

```text
NodeExecutionEnv baseline
MemoryExecutionEnv synthetic contract
```

The memory contract applies the synthetic environment sources to a Pi checkout and runs normal Pi `read/write/edit/bash` tools against a seeded RAM-only workspace. The resulting artifact is checked against the immutable base revision.

```bash
./integrations/pi-e2e/install-memory-test.sh /path/to/pi
cd /path/to/pi
pnpm vitest packages/agent/test/synth-runtime-memory.e2e.test.ts
```

Target Pi source baseline: `earendil-works/pi` commit `36b60d2e8985899743c4cf5bd5f8929832a3f05d`.

### Live Postgres and Kubernetes contracts

The artifact environment does not provide Docker, PostgreSQL, `kubectl`, or a Kubernetes cluster, so those contracts are bundled but not falsely reported as executed.

For a real PostgreSQL instance:

```bash
cd integrations/postgres
npm install
export SYNTH_POSTGRES_URL='postgres://...'
npx tsx smoke.ts
npx tsx concurrency.ts
```

`concurrency.ts` races multiple independent connections against the same command/effect identities and requires exactly one claim winner.

For a real Kubernetes/gVisor cluster:

```bash
export SYNTH_EXECUTOR_IMAGE='registry/synth-executor@sha256:...'
npx tsx integrations/kubernetes/kill-chaos.ts
```

The script force-deletes a real executor Pod while `kubectl exec` is active and requires the execution not to report success.

## Build and test

```bash
npm run build
npm test
npm run process-crash:contract
npm run responses:contract
npm run chaos:matrix
```

The root suite contains **30 passing tests** in this artifact environment, including the real `SIGKILL` contract and real HTTP gateway contract.

## What remains intentionally external

- live PostgreSQL contention run;
- live Kubernetes Pod-kill run;
- Pi monorepo E2E execution;
- real OpenCode subscription credentials/provider traffic;
- end-to-end Temporal worker/server failure testing.

The source, installers, and contracts for those are included so the next milestone can be measured rather than redesigned.

## Documentation

- `ARCHITECTURE.md` — runtime/trust boundaries.
- `RECOVERY.md` — restart and process-death semantics.
- `TRANSACTIONS.md` — semantic buffering and replay boundary.
- `RESPONSES.md` — Responses compatibility surface.
- `LIVE-CONTRACTS.md` — external Postgres/Kubernetes/Pi verification.
- `POSTGRES.md` — database persistence and contention contract.
- `CHAOS.md` — failure injection and real process kill.
- `PI-E2E.md` — Pi Node + memory environment contracts.
- `INFERENCE.md` — logical models, stacked OpenCode routing and transparency.
- `KUBERNETES.md` — gVisor resource/isolation model.
- `HARDENING.md`, `OBSERVABILITY.md`, `TEMPORAL.md`, `WORLD.md`, `SUPER.md`, `SPEC.md`.
- `docs/MARKDOWN-MANIFEST.md` — complete Markdown inventory.
