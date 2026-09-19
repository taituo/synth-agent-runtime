# Synth Agent Runtime v0.7

v0.7 is a **live-proof + retrospective-hardening** release. It keeps the durable-agent architecture from v0.1–v0.6, adds repeatable CI/live-system entry points, expands the Responses transport, and fixes several concurrency/crash-safety defects found by reviewing the older code paths backward from real failure boundaries.

The core rule is still:

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
        ├ account/provider A
        ├ account/provider B
        └ configured fallback
              │
              ▼
          Agent Runtime
      ┌───────┼───────────┐
      │       │           │
 durable   project     durable turn
 state      world       boundary
      │                   │
      └──────────┬────────┘
                 ▼
        MemoryWorkspace + lazy Git
                 │
          ExecutionBroker
          ├ synthetic RAM
          ├ gVisor/Kubernetes
          └ ProjectCell
```

## What changed in v0.7

### Retrospective correctness fixes

The backward code review found and fixed several bugs that were more important than adding new features:

- attempt-local tool/effect receipts are scoped per durable retry attempt, so a provider retry cannot reuse a receipt from a workspace state that was rolled back;
- semantic exposure is persisted **before** an irreversible/barrier effect crosses the external boundary;
- recovery marks interrupted exposed turns `failed/reconciliation required` instead of claiming a transparent rollback;
- Kubernetes warm-pool creation no longer has a double-lease race and queued waiters are rejected cleanly on close/failure;
- physical workspace sync-back is atomic on failure/limit violations;
- durable turn metadata writes are serialized so delayed `started` writes cannot overtake terminal commit;
- buffered output publication is now a persisted semantic boundary;
- runtime output/tool events are serialized before completion and observer exceptions are isolated;
- kubectl Git-status failures are no longer silently interpreted as “no changes”;
- native Git no longer hides arbitrary `stat()` failures, distinguishes missing treeish errors, and continuously drains the long-lived `cat-file --batch` stderr pipe.

See [`CODE-REVIEW.md`](CODE-REVIEW.md) for fixed and remaining findings.

### Gateway and routing hardening

- configurable request body limit, 16 MiB by default;
- HTTP streaming respects backpressure;
- disconnect/cancellation propagates through server → router → upstream/Pi model stream;
- retryable upstream response bodies are cancelled before failover;
- `metadata.session_id` can drive Responses affinity in addition to session headers;
- deterministic `Retry-After` parsing is testable with an injected clock.

### Responses transport

v0.7 expands the coding-agent Responses subset with:

```text
response.created
response.in_progress
response.output_item.added/done
response.content_part.added/done
response.output_text.delta/done
response.reasoning_summary_part.added/done
response.reasoning_summary_text.delta/done
response.function_call_arguments.delta/done
response.completed
response.incomplete
response.failed
```

The Pi/OpenCode adapter maps Pi thinking blocks into reasoning-summary events, preserves usage details, uses the current request's instructions during continuation, and maps strict tools to required strict constrained sampling where supported.

`previous_response_id` storage is still process-local in the bundled adapter; the review marks shared/durable continuation as v0.8 work rather than pretending this is multi-replica complete.

### Live proof automation

Run all proofs available in the current environment:

```bash
npm run live:proof
```

Optional real-system proofs are enabled through environment variables instead of being silently skipped inside individual test code. See [`LIVE-PROOF.md`](LIVE-PROOF.md).

GitHub Actions definitions are included for core verification, PostgreSQL contention, pinned Pi E2E, and a manual/self-hosted gVisor Kubernetes live test.

## Verification performed for this artifact

```text
npm test
  49 tests
  49 passed
  0 failed

npm run process-crash:contract
  1 / 1 passed

npm run responses:contract
  6 / 6 passed

npm run integrations:syntax
  25 TypeScript integration files
  0 syntax diagnostics
  4 shell files pass bash -n

npm run live:proof
  PASS core suite
  PASS integration syntax
  PASS SIGKILL recovery
  PASS Responses contracts
  SKIP live PostgreSQL: SYNTH_POSTGRES_URL not set
  SKIP Pi E2E: PI_REPO not set
  SKIP live Kubernetes: SYNTH_K8S_LIVE != 1
  SKIP live external gateway: SYNTH_GATEWAY_URL not set
```

The skipped integrations need real external infrastructure/credentials and are **not** reported as passed.

## Build

Requirements: Node.js 22+ and TypeScript 5.8+.

```bash
npm install
npm run build
npm test
```

For reproducible release CI, the review recommends generating a checked-in lockfile in a networked build environment and switching CI to `npm ci`; this artifact environment did not have usable package-network access, so no fabricated lockfile is included.

## Key directories

```text
src/
├ core/             agent/task/relation/artifact primitives
├ runtime/          AgentRuntime + durable turn boundary
├ durability/       local/file state contracts
├ postgres/         shared Postgres persistence
├ inference/        gateway, routing and Responses protocol
├ workspace/        RAM workspace + native lazy Git
├ execution/        broker + Kubernetes/gVisor executors
├ orchestration/    Super/delegation
└ observability/    traces

integrations/
├ opencode-http-gateway/
├ opencode-live/
├ pi-e2e/
├ postgres/
├ kubernetes/
├ temporal/
├ pi-opencode-stack-router/
└ pi-synthetic-git-prototype/
```

## Documentation

Start with:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system and trust boundaries.
- [`SPEC.md`](SPEC.md) — original long design specification.
- [`CODE-REVIEW.md`](CODE-REVIEW.md) — backward review, fixed defects and remaining risks.
- [`LIVE-PROOF.md`](LIVE-PROOF.md) — local/CI/live verification matrix.
- [`RECOVERY.md`](RECOVERY.md) — restart and process-death semantics.
- [`TRANSACTIONS.md`](TRANSACTIONS.md) — output/effect/workspace transaction boundary.
- [`RESPONSES.md`](RESPONSES.md) — gateway Responses subset.
- [`POSTGRES.md`](POSTGRES.md) — shared persistence and atomic claims.
- [`KUBERNETES.md`](KUBERNETES.md) — gVisor execution/isolation model.
- [`PI-E2E.md`](PI-E2E.md) — Pi harness contracts.
- [`ROADMAP.md`](ROADMAP.md) — review-driven v0.8 work.
- `docs/MARKDOWN-MANIFEST.md` — every bundled Markdown file, including preserved v0.1–v0.6 history.

## Status

v0.7 is a strong prototype/reference implementation with real local crash and protocol contracts. It is not yet a claim of production completeness. The main remaining distributed-system gaps are shared continuation/router state, command reconciliation, concurrent world mutations, mailbox/event cursors, gateway tenant security, and real external-system CI execution. Those are listed explicitly in `CODE-REVIEW.md` rather than hidden behind the passing local suite.
