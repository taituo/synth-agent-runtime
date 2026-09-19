# Backward code review — v0.1 → v0.7

This review walks backward through the runtime from the v0.7 execution paths into the older design layers. It is intentionally stricter than the release notes: a feature being present is not enough; the review asks whether its failure semantics are explicit, durable, and safe under retries, process death, provider failover, and sandbox reuse.

## Review scope

Reviewed areas:

- `src/runtime`, durable turns, command/effect receipts and recovery;
- inference gateway, provider/account routing and Responses transport;
- Kubernetes warm-pool, workspace materialization and sync-back;
- memory workspace and native Git source;
- Postgres persistence and canonical project world;
- Super/orchestration, mailbox semantics and external integrations;
- Pi E2E contracts, Temporal boundary and deployment manifests;
- tests and CI/live-proof automation.

The review distinguishes **fixed in v0.7** from **remaining work**. Remaining findings are not hidden by a passing unit suite.

## High-impact findings fixed in v0.7

### CR-001 — retry could replay an attempt-local effect receipt after workspace rollback — fixed

**Severity: critical correctness.**

Earlier durable turns sent `workspace.write`, `workspace.delete`, `process.exec`, and similar attempt-local effects to the global `ExecutionBroker` using the caller's stable effect ID. If provider attempt A executed the effect and then failed, the workspace was rolled back. Attempt B could then submit the same effect ID and receive the already-committed receipt without executing the effect again, leaving the retried logical workspace inconsistent with the model's observed tool result.

v0.7 scopes attempt-local executor IDs to the durable turn:

```text
logical effect: edit-17
attempt A:      edit-17::turn-A
attempt B:      edit-17::turn-B
```

Commit/barrier effects keep the stable caller ID because those cross the transaction boundary and must deduplicate globally. Regression coverage: `attempt-local effect receipts are scoped per durable retry attempt`.

### CR-002 — semantic exposure barrier was not durably ordered before external execution — fixed

**Severity: critical crash safety.**

The old code could set `semanticExposed = true` in memory and start an irreversible/barrier effect before the updated turn record was guaranteed durable. A process crash in that window could leave a durable `started` turn that looked safe to roll back.

v0.7 persists the exposure bit before crossing the effect boundary. Recovery now treats an interrupted exposed turn as `failed` and requires reconciliation; it does not claim a transparent rollback. Regression coverage: `recovery does not label a semantically exposed turn as transparently rolled back`.

### CR-003 — warm sandbox pool could double-lease a newly created slot — fixed

**Severity: critical isolation.**

A concurrent acquire could become a waiter while another acquire was creating a sandbox. The creation path could hand the slot to the waiter and then the original caller could attempt to lease the same slot. v0.7 separates slots reserved for the direct creator from slots created by warm-pool maintenance, rejects waiters on close/failure, and destroys released slots after pool closure. Regression coverage includes the double-lease race and queued-waiter close behavior.

### CR-004 — Kubernetes sync-back could partially mutate the logical workspace — fixed

**Severity: high correctness.**

The old sync-back path applied changed files incrementally. A size/read failure halfway through could leave half of a physical sandbox result committed to the RAM workspace. v0.7 snapshots before sync-back and restores on any failure. Regression coverage: `workspace sync-back is atomic when sandbox output exceeds limits`.

### CR-005 — physical Git-status failure could be interpreted as “no changes” — fixed

**Severity: high data-loss risk.**

The kubectl backend previously returned an empty change set when `git status` failed. A broken baseline or sandbox error could therefore silently drop agent changes. v0.7 throws instead and includes sandbox/stdout/stderr context.

### CR-006 — cancellation stopped at the HTTP boundary — fixed

**Severity: high resource/correctness risk.**

Client disconnects and request cancellation were not consistently propagated through the gateway/router/upstream stack. v0.7 forwards `AbortSignal` through the profile router, HTTP upstream, and Pi adapter. The HTTP server cancels the backend stream if the client disconnects.

### CR-007 — gateway body size and streaming backpressure were weak — fixed

**Severity: high availability.**

The gateway now has a configurable request-size ceiling (16 MiB default), returns 413 before backend dispatch, respects Node response backpressure, and cancels an upstream reader when the downstream client disappears.

### CR-008 — Responses compatibility missed important coding-agent semantics — fixed/expanded

**Severity: high interoperability.**

v0.7 adds reasoning summary event families, explicit incomplete terminal events/details, nested input parsing, richer usage details, stricter tool schema mapping, and correct current-request instruction handling for `previous_response_id` continuation. Pi thinking events are mapped to Responses reasoning-summary events.

### CR-009 — native Git masked too many failures and could leave stderr undrained — improved

**Severity: medium reliability.**

`stat()` no longer converts arbitrary Git failures into “missing file”. `listDir()` only maps recognized missing-treeish errors to an empty directory and rethrows other failures. The persistent `git cat-file --batch` child now drains stderr so repeated warnings cannot fill the pipe and stall blob hydration.

### CR-010 — fire-and-forget turn metadata writes could overtake terminal commit — fixed

**Severity: critical durability ordering.**

`emitOutput()`/`stageEffect()` scheduled asynchronous `putTurn(started)` writes without serializing them with `commit()`. On a multi-connection/variable-latency store, an older delayed `started` write could land after the terminal `committed` record and resurrect an already-completed turn as in-flight. v0.7 now serializes turn persistence through one ordered queue, flushes pending metadata before external commit work, and regression-tests a deliberately delayed store.

### CR-011 — buffered output publication was an unrecorded semantic boundary — fixed

**Severity: critical replay safety.**

The old commit path published buffered tool/output semantics and only then wrote the terminal committed turn. A crash during publication could leave the durable turn looking safely retryable even though a human/client had already observed part of the output. v0.7 persists `semanticExposed=true` before publishing any buffered semantic event. A crash in that window now recovers fail-closed/reconciliation-required rather than transparently replaying the turn.

### CR-012 — runtime output/tool event writes could reorder behind completion — fixed

**Severity: high event-log correctness.**

Agent engines emit output/tool callbacks synchronously while durable event append is asynchronous. The old `void #emit(...)` path could let `agent.completed` overtake earlier output records or create unhandled durability rejections. v0.7 serializes runtime events, flushes streamed events before persisting completion, and isolates throwing UI/listener observers from the durable agent execution path.

### CR-013 — failed logical commands were implicitly reclaimable — fixed

**Severity: critical idempotency.**

`AgentRuntime.command()` previously wrote `failed` whenever its callback threw. The Postgres command claim intentionally permits reclaiming `failed`, so an arbitrary command that completed an external action and then lost its response could be executed twice. v0.7 now fails closed by default: a thrown command remains `started` with an `uncertain:` error and subsequent calls receive `COMMAND_OUTCOME_UNCERTAIN`. Only callers that explicitly set `retrySafeOnError` produce a reclaimable `failed` record.

### CR-014 — route health IDs collided across virtual models — fixed

**Severity: high routing correctness.**

Router health was keyed only by `route.id`. Two model profiles using a conventional ID such as `primary` shared cooldown state even when they pointed at unrelated providers. A 429 for one model could disable another model's healthy route. v0.7 namespaces route health by virtual model + route ID and adds a regression test.

### CR-015 — HTTP upstream forwarded hop-by-hop framing headers — fixed

**Severity: medium transport/security hardening.**

The transparent HTTP backend removed `Host` but could copy caller-supplied connection/framing headers to the upstream fetch. v0.7 strips standard hop-by-hop/framing headers (`connection`, `transfer-encoding`, `content-length`, etc.) while preserving end-to-end headers.

## Remaining findings

### CR-R01 — started commands have no ownership lease or reconciliation path

**Severity: P1.** v0.7 now correctly leaves an exception uncertain by default, but a process that dies while a command is genuinely still running also leaves a `started` record with no owner lease/fencing information. It can remain permanently blocked. Blind timeout reclaim would be unsafe because the command may have crossed an external side-effect boundary.

**Needed:** command class/semantics, owner + lease/heartbeat/fencing token, explicit reconciliation state, and a retry policy that only reclaims operations proven replay-safe.

### CR-R02 — canonical project/world writes are last-writer-wins

**Severity: P1.** `putProject()`/`putTask()` use whole-document JSONB upserts. Concurrent supervisors can overwrite each other's decisions, task IDs, or metadata.

**Needed:** revision/CAS (`expected_revision`) or normalized append-only world operations plus transactional projections. Super should mutate through those operations rather than read-modify-write whole documents.

### CR-R03 — runtime events are unbounded and read all-at-once

**Severity: P1.** `listEvents()` returns the complete log. A long-running installation will eventually turn startup/query paths into an unbounded memory/latency operation.

**Needed:** sequence cursor, limit, retention/archival, and subscriber checkpoints.

### CR-R04 — Responses continuation state is process-local

**Severity: P1.** The OpenCode gateway adapter stores `previous_response_id` context in an in-memory `Map`. A gateway restart or a request landing on another replica loses the continuation.

**Needed:** shared/durable response-context store or a provider-native continuation identifier with explicit lifecycle/TTL.

### CR-R05 — router affinity and health are process-local

**Severity: P1.** Account stickiness/cooldowns are correct inside one router process but diverge across replicas.

**Needed:** shared affinity/health state, or deterministic rendezvous routing plus a shared health/cooldown feed. The choice should preserve provider session affinity without creating a central hot lock.

### CR-R06 — gateway assumes a trusted ingress

**Severity: P1 security.** The runtime gateway does not itself provide tenant authentication, authorization, model/profile ACLs, or rate limits.

**Needed before direct exposure:** mTLS or bearer/API-key middleware, tenant identity propagation, per-tenant profile permissions, request/concurrency quotas, and audit fields. It is acceptable today only behind a trusted authenticated ingress.

### CR-R07 — mailbox consumption is not represented as a durable cursor

**Severity: P1.** Agent snapshots keep the complete mailbox and `run()` passes it to the engine. Message IDs prevent duplicate insertion, but there is no durable “consumed through sequence N” contract. Generic engines can reprocess old input and mailbox size grows indefinitely.

**Needed:** append-only message sequence + durable cursor/ack per lane/agent, with retention after all required consumers pass the entry.

### CR-R07b — agent snapshots/mailboxes are whole-document last-writer-wins across replicas

**Severity: P1.** The Postgres agent row stores the full snapshot, including mailbox. Two runtime replicas can read the same snapshot, append different messages/state, and overwrite each other. Message-ID deduplication is only local to one live snapshot and is not an atomic database constraint.

**Needed:** exclusive agent ownership/fencing plus normalized durable mailbox/message rows (or append-only operations) with unique message IDs and consumer cursors. Recovery must only mutate a turn/agent after proving ownership of that generation.

### CR-R08 — buffered turn output is counted durably, not stored durably

**Severity: P1.** Durable turn records store `bufferedOutputCount` and staged effect IDs, while the actual output/tool buffers live in process memory. This is safe for a non-exposed crash because recovery rolls back, but it cannot resume an exact partially generated turn.

**Needed if exact resume is required:** persist compact output/tool frames or deliberately specify “model turn restarts from the durable pre-turn boundary”. Do not imply exact mid-stream continuation until then.

### CR-R09 — uncertain external effects need first-class reconciliation

**Severity: P1 operations.** The fail-closed receipt is the correct default, but an operator/runtime still needs a standard way to answer “did deployment/message/job X actually happen?”

**Needed:** `EffectReconciler` interface, effect-kind adapters, operator-visible state (`uncertain → committed/failed/retryable`), and Temporal/activity integration.

### CR-R09b — durable effect/affinity identities are not tenant-namespaced

**Severity: P1 multi-tenant security/correctness.** `Effect.id`, response continuation IDs, and session affinity keys assume one trusted identity namespace. If the gateway/runtime later serves multiple tenants directly, identical user-supplied IDs could collide or share routing state.

**Needed:** authenticated tenant identity as part of durable idempotency keys, continuation storage keys, route-affinity keys, audit records and database row ownership.

### CR-R10 — Kubernetes production invariants are documented more strongly than enforced

**Severity: P2 security/operations.** The manifests support strong defaults, but executor image digest pinning is not mandatory in code, DNS/egress policy details vary by cluster, and ProjectCell services may still need writable roots or secrets.

**Needed:** production validation mode requiring digest-pinned images, explicit secret references/broker, cluster-specific DNS configuration, admission-policy examples, and live reset/pod-kill CI on a real gVisor runner.

### CR-R11 — Git backend still lacks shared object/cache policy

**Severity: P2 performance/repository semantics.** Each source can use a persistent batch reader, but multi-agent installations still need a shared immutable object store/cache, bounded eviction, explicit LFS/submodule policy, and metrics for lazy hydration.

### CR-R12 — reproducible dependency locking is incomplete

**Severity: P2 supply-chain/reproducibility.** There is no checked-in npm lockfile for the root artifact. CI can therefore resolve slightly different dev dependency versions.

**Needed:** generate and commit a lockfile in a networked build environment, use `npm ci`, pin external action/tool versions, and add SBOM/provenance if this becomes a distributed release artifact.

### CR-R13 — Temporal is still an integration boundary, not a killed-worker proof

**Severity: P2 durability validation.** The architecture fits Temporal, but a real Temporal server/worker crash matrix has not been run here.

**Needed:** activity idempotency tied to command/effect IDs, worker SIGKILL tests, workflow replay tests, and explicit reconciliation for non-idempotent effects.

### CR-R13b — recovery has no distributed owner fencing

**Severity: P1 HA correctness.** `AgentRuntime.recover()` is correct after a known-dead single owner, but a second replica can theoretically recover/rollback `started` turns while the original worker is merely partitioned or slow. PostgreSQL persistence alone does not fence the stale worker.

**Needed:** per-agent/turn generation or lease token checked on every mutating write, lease expiry/renewal, and recovery only after acquiring the next fenced generation.

### CR-R14 — `process.exec` replay safety is classified too coarsely

**Severity: P1 effect semantics.** `defaultEffectReplayMode()` treats every `process.exec` as attempt-local. That is valid for a credential-free isolated build/test sandbox, but not for a process with network access or credentials that can publish, deploy, send messages, mutate a database, or call another side-effecting service. Workspace rollback cannot undo those effects.

**Needed:** explicit effect replay-safety metadata/capabilities, executor attestation/policy for “transaction-local process”, and barrier/commit classification whenever a process can reach non-transactional external state.

### CR-R15 — the runtime event queue is process-global

**Severity: P2 scalability.** v0.7 correctly serializes events to prevent reordering, but one slow durable append currently backpressures event persistence for all agents in that `AgentRuntime` process.

**Needed at scale:** ordered per-agent/per-stream lanes feeding a globally sequenced durable log, or a database append service that provides sequence numbers without one JavaScript-wide queue.

## Historical review by version

```text
v0.1  good abstraction seams; little distributed failure proof
  ↓
v0.2  Kubernetes executor/pool added; later review found pool + sync-back races
  ↓
v0.3  world/Super/transactions added; world concurrency still last-writer-wins
  ↓
v0.4  durability/effect receipts added; later review found attempt-local receipt and barrier-order windows
  ↓
v0.5  Postgres + claims + chaos; command-started reconciliation remains deliberately fail-closed
  ↓
v0.6  SIGKILL + Responses + live contracts; continuation/router state remained process-local
  ↓
v0.7  fixes the high-impact races/windows above and adds repeatable live-proof CI entry points
```

## v0.8 review-driven priority

The next version should not add another large abstraction layer. It should close the remaining shared-state gaps in this order:

1. CAS/event-sourced project world + durable mailbox cursor.
2. Command lease/reconciliation, explicit process/effect replay-safety, and generic `EffectReconciler`.
3. Shared Responses continuation + router affinity/health.
4. Gateway tenant auth/ACL/rate limits.
5. Event cursor/retention and operational queries.
6. Real Postgres/Pi/gVisor/Temporal CI runs with process/pod/worker kills.
7. Reproducible lockfile/SBOM and production image-digest enforcement.

The target invariant is unchanged: **after any single process/provider/pod failure, the system either recovers from a durable boundary or stops in an explicit state that cannot silently duplicate an external effect or discard workspace state.**
