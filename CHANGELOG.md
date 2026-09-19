# Changelog

## 1.0.0-rc.1 — abort-safety fix folded in, git ref/remote argument-injection fixed

### Park transient turn failures instead of dying

- **A short provider outage killed a durable agent permanently.** Any `runTurn`
  activity failure that exhausted the workflow's retry policy set
  `status = "failed"` and ended the loop, so roughly three seconds of
  flaky/rate-limited inference was fatal — the opposite of what a durable agent
  is for. The workflow now classifies the failure first. A **permanent** failure
  (`ApplicationFailure.nonRetryable`; the gateway activity marks HTTP
  400/401/403/404/422 this way) still ends the agent immediately with one
  attempt. A **transient** one (HTTP 408/409/425/429/5xx, timeouts, network
  errors, empty or malformed completions) now **parks** the agent instead:
  `status = "waiting"`, the failed turn's messages stay in the mailbox, and
  `lastError` holds the root cause (visible through `getAgentState`). It waits
  with exponential backoff — default 5s initial, x2, capped at 5 min, overridable
  per agent via the new optional `parkBackoff` on the initial state — then
  retries the same turn. On success the backoff resets and `lastError` is
  cleared. The wait is cancellation-aware (`condition(() => cancelled,
  backoffMs)`), so cancelling a parked agent is prompt; new messages do not cut
  the backoff short because the provider is presumably still down. Each park
  logs `synth.workflow.parked` with `{attempt, backoffMs, error}` through the
  existing interceptors. Added sandbox-safe `isNonRetryableFailure` (cause-chain
  walk) and `nextParkBackoffMs` helpers to `src/correlation.ts`. Unit tests cover
  the cause-chain walk (including a cyclic chain), the backoff growth/cap/override
  and the gateway's permanent-vs-transient HTTP classification. `park-live.ts`
  proves it against a real dev server: a transient outage outlasting one retry
  cycle parks (mailbox intact, cause visible) then recovers to `idle` with
  `lastError` cleared; a non-retryable failure ends `failed` in exactly one call;
  cancelling while parked reaches `cancelled` in ~60 ms. The inference swarm
  driver gained an `EXPECT_PARKED` mode so an always-down provider is asserted as
  parked, not failed. An agent that parks and retries forever grows workflow
  history; Continue-As-New is the production remedy and is out of scope here.

### Swarm against real inference, with injected faults

- **The swarm had only ever run against an instant echo stub.** The typed-event
  swarm proved the Temporal plumbing (signals, per-instance workflows,
  correlation isolation) but never put a real model behind `runTurn`, so slow
  inference, batching, and inference failure were all untested. Added
  `createGatewayRunTurn` (`integrations/temporal/src/gateway-run-turn.ts`), a
  `runTurn` activity that classifies each event in the turn's batch through any
  OpenAI-compatible gateway. The typed `kind` is never sent to the model, so it
  stays a planted ground truth to score against. The activity heartbeats while
  it waits (the workflow sets a 1-minute heartbeat timeout and a reasoning model
  takes 8-14 s per call), aborts calls that outlive a timeout, and throws on any
  HTTP error, empty completion or structurally invalid answer so Temporal's
  retry policy decides what happens next. Seven unit tests cover the request
  shape, kind-hiding (verified by mutation: leaking the kind into the prompt
  fails two tests), fenced/prosey JSON, the error paths, heartbeat and timeout.
- **`swarm-inference-driver.ts`** runs three concurrent agents (12 events) with
  real model calls through this repo's gateway and scores the result: per-event
  accuracy against the planted kind, no event lost/duplicated/reordered by
  batching, empty mailbox and no error at the end, and the same correlation
  isolation checks as the stub swarm. Because a model call is far slower than
  the 200-400 ms between events, events pile up during a turn and are taken as
  a batch by the next one (every agent ran `[1, 3]`), which is exactly the
  mid-turn-arrival case the earlier mailbox fix had to get right.
  Live result, three runs against the OpenCode-backed gateway
  (`muse-spark-1.3-contributor`): 36/36 classifications correct, 0 retries,
  6 model calls and ~5.2k tokens per run, 13-16 s wall-clock. The scripts use
  deliberately unambiguous texts, so 100% accuracy is a floor check, not a
  measure of model quality; the gate is 75% because a real model may disagree.
- **`flaky-gateway.ts`** is a fault-injecting reverse proxy for a real gateway
  (HTTP 502, HTTP 200 with a non-JSON reply, or a request that never answers),
  so failure handling is exercised with genuine HTTP faults rather than mocks.
  Live through Temporal: two injected 502s and two injected garbage replies were
  each retried and recovered (2 retried turns, all 12 events classified); one
  hung request was aborted by a 25 s call timeout and retried (1 retry,
  recovered); with every request failing, all three agents ended `failed` after
  three attempts each, reported the real cause (`gateway returned HTTP 502`),
  and the driver returned in 4 s instead of hanging.
- Also removed `integrations/temporal/dist/` from version control (it had been
  committed by accident in an earlier commit and was already stale) and
  ignored `integrations/*/dist/`.

### Small concurrent swarm with correlation-isolation proof

- **Concurrent durable agents had never been checked for telemetry
  cross-contamination.** Added `integrations/temporal/swarm-driver.ts`, a
  runnable tool that starts three separate `durableAgentWorkflow` instances at
  once, each fed its own distinct typed-event schedule from the new
  `SWARM_SCRIPTS`, then asserts (a) each instance processed exactly its own
  ordered kinds and (b) no trace event or worker log ever pairs one instance's
  `agentId` with another's `workflowId`. The pure checks
  (`swarmIsolationViolations`, `logCorrelationViolations`) are unit-tested
  against synthetic crossed/foreign/missing-agent cases, and the shared
  worker/client harness was factored into `event-runner.ts` so the single-agent
  `event-driver.ts` and the swarm use the same path. Verified live against a
  Temporal dev server (`npm run live:swarm`): all three instances drained to
  `idle` with their own sequences (`news`→…, `incident`→…, `social_post`→…),
  `sequenceOk: true`, `isolationOk: true`, zero trace/log violations; the
  refactored single-agent driver still reports deterministic replay.

### Scripted typed-event driver for the Temporal integration

- **There was no way to exercise a durable agent against an ordered event
  timeline**, only one-off signals, so a realistic sequence of typed events
  (and whether it replays deterministically) could not be tested. Added a
  runnable tool, `integrations/temporal/event-driver.ts`, that fires a fixed,
  four-event schedule (`news` → `social_post` → `incident` → `news`, spaced
  250-400 ms apart) into one running `durableAgentWorkflow`, then queries the
  final state and recovers the ordered kinds of the turns actually processed
  from the activity trace spans. Running it twice asserts deterministic replay:
  both sessions must produce the same processed-signal sequence and the same
  volatile-field-free final-state projection. The pure schedule/projection/
  sequence helpers live in `event-script.ts` and are unit-tested without a
  server (four new tests: schedule shape, projection stripping ids/timestamps,
  per-agent ordered sequence, replay comparison). Verified live against a
  Temporal dev server (`npm run live:driver`): both runs processed
  `["news","social_post","incident","news"]`, drained the mailbox to `idle`,
  and reported identical final state.

### Typed mailbox signals in the Temporal integration

- **The durable agent's `sendMessage` signal carried no event type**, so a
  mailbox message could only be described by free text — traces and logs could
  be filtered by agent but not by the kind of event that drove a turn. Added an
  optional `kind?: string` to a new exported `DurableMailboxMessage` interface
  (used by `DurableAgentState.mailbox` and `RunTurnInput.messages`), and a
  sandbox-safe `messageKindFromArgs` helper that reads the kind off either a
  `{ messages: [...] }` activity input (the last, driving message) or a bare
  `sendMessage` payload. The activity interceptors now attach `messageKind` to
  every activity log line and trace span, and the workflow-isolate signal
  interceptor includes it on the `synth.workflow.signal` log. The field is
  omitted entirely for legacy untyped messages, so existing callers, signals,
  and serialized state are unaffected. Regression tests cover the extractor's
  both-shapes/legacy/invalid-kind cases and the activity interceptor's typed vs.
  untyped attributes; verified live against a Temporal dev server
  (`integrations/temporal/interceptors-live.ts`) that a `kind: "incident"`
  signal round-trips into the workflow's final state and shows up as
  `messageKind` in both trace attributes and worker logs.

### Durable named event-consumer ACK and safe retention watermark

- **`pruneEvents(throughSeq)` trusted the caller**, so a lagging named
  consumer's unread events could be deleted — nothing computed a safe
  retention bound from consumers' actual read positions. Added an optional
  event-consumer ACK registry to `DurabilityProvider` (`ackEvent`,
  `getEventCursor`, `listEventCursors`, `forgetEventConsumer`,
  `safeEventWatermark`, `pruneEventsSafe`), implemented for the in-memory,
  JSON-file, and PostgreSQL stores (new `synth_event_cursors` table) and
  forwarded through `ChaosDurabilityProvider`. Acks are monotonic and clamped
  to the current max sequence; the watermark is the minimum ack across
  registered consumers, and `pruneEventsSafe` prunes only through it. With no
  registered consumer the watermark is 0 and nothing is pruned, so an
  unconfigured deployment fails closed. The raw `pruneEvents` is unchanged and
  remains the caller-owned primitive. Verified live against PostgreSQL: two
  consumers at 3 and 5 yield watermark 3, a clamped ack raises it to 5, and
  safe pruning removes exactly the acked prefix. Regression tests cover the
  watermark semantics, the fail-closed empty case, the PostgreSQL store, and
  chaos forwarding.

Root suite: 100/100 (97 + 3 new tests).

### Per-record compare-and-swap for tasks and artifacts

- **Task and artifact records were last-write-wins bodies.** Project
  membership/decisions already had `compareAndSwapProject`, but individual
  task/artifact updates had no equivalent, so two writers could clobber each
  other with no conflict signal. Added an optional `revision` to `TaskSpec`
  and `Artifact`, and optional `compareAndSwapTask`/`compareAndSwapArtifact`
  to `WorldStore`, mirroring `compareAndSwapProject`: replace only when the
  stored revision equals `expectedRevision`, write `revision + 1`, and return
  the current record when it does not. Implemented for the in-memory,
  JSON-file, and PostgreSQL stores; the PostgreSQL path uses the same
  `body->>'revision'` guard as projects, so no schema change is needed and
  `putTask`/`putArtifact` stay last-write-wins for callers that do not opt in.
  Verified live against PostgreSQL (a stale-revision write is rejected for
  both a task and an artifact). Regression tests cover stale-revision
  rejection in the in-memory and PostgreSQL stores.

Root suite: 97/97 (95 + 2 new tests).

### Shared (cross-replica) tenant rate limiting

- **Tenant rate limiting was per-process only.** `InMemoryTenantRateLimitPolicy`
  (`src/inference/gateway/tenant-policy.ts`) kept its window in process memory,
  so with N gateway replicas each replica enforced the full configured limit
  and the effective limit multiplied by the replica count. Added a
  `SharedRateLimitStore` abstraction with `InMemorySharedRateLimitStore`
  (local/tests) and `PostgresRateLimitStore` (new `synth_rate_limits` table
  with an atomic per-(tenant, window) upsert), plus
  `SharedTenantRateLimitPolicy`, which increments the shared counter so a
  tenant's limit is global across replicas. `InMemoryTenantRateLimitPolicy` is
  left unchanged for deliberately single-process use. Verified live against
  PostgreSQL: two store/policy instances sharing one database allowed exactly
  the configured 5 of 8 requests at `requestsPerMinute: 5`. Regression tests
  cover the shared policy across two "replicas" and the Postgres store.

Root suite: 95/95 (93 + 2 new tests).

### Caller-supplied Kubernetes namespaces are validated

- **A caller-supplied namespace reached `kubectl` unvalidated**
  (`src/execution/kubernetes/kubectl-backend.ts`,
  `src/execution/kubernetes/project-cell.ts`). Derived pod/service names are
  sanitized by construction, but a namespace the caller names
  (`KubectlSandboxBackendOptions.namespace` / `create({ namespace })` /
  `ProjectCellSpec.namespace`) was used as-is, so a malformed value surfaced
  only as an opaque API rejection once `kubectl apply` ran (and a name with
  invalid characters or more than 63 characters could never succeed). Added
  `assertValidNamespace`, enforcing the DNS-1123 label rules with a clear error
  before anything is applied. It validates rather than silently rewriting: a
  caller-named namespace is referenced elsewhere, so renaming it could target
  a different namespace than intended. `KubectlSandboxBackend` validates both
  its constructor default and the per-`create` override; `ProjectCellManager`
  validates `spec.namespace`. Regression tests cover a valid name, a range of
  invalid inputs, and that no objects are applied when the namespace is
  rejected.

Root suite: 93/93 (91 + 2 new tests).

### StaticBearerAuthenticator compares bearer tokens in constant time

- **Bearer tokens were matched with `Map.get`**
  (`src/inference/gateway/tenant-policy.ts`), a non-constant-time lookup that
  can leak, via response timing, how many leading characters of a presented
  token match a known one — a token oracle against a static shared secret.
  Each known token is now stored as a SHA-256 digest and the presented token
  is digested and compared with `crypto.timingSafeEqual`, with no early exit,
  so comparison cost does not depend on the matching prefix and a length
  mismatch can neither throw nor leak. Regression test covers valid and
  invalid tokens of equal and differing lengths, a missing header, and a
  non-Bearer scheme.

Root suite: 91/91 (90 + 1 new test).

### ChaosDurabilityProvider now forwards the optional durability surface

- **`ChaosDurabilityProvider` silently dropped
  `putAgentFenced`/`readEvents`/`pruneEvents`** (`src/chaos/wrappers.ts`).
  Wrapping a provider in the chaos failpoint provider hid those optional
  capabilities: a fenced agent write, or a resumable/prunable event read,
  through the wrapper behaved as if the underlying store didn't support them
  at all — and because `persistAgentSnapshot` decides between fenced and
  unfenced writes by checking `provider.putAgentFenced`, the wrapper could
  misreport a fenced store as unfenced. Fixed by forwarding each optional
  method only when the wrapped provider actually implements it, mirroring the
  existing `claimCommand`/`claimEffect` optional-forwarding pattern in
  `ChaosRuntimeStateStore`. When the wrapped store genuinely cannot fence, the
  method stays absent so the runtime still fails closed with
  `FENCED_AGENT_WRITE_UNSUPPORTED` instead of a silent fence rejection. The
  regression test covers both the forwarding path and the absent-capability
  path.

Root suite: 90/90 (89 + 1 new test).

### Effect receipts are now monotonic; a resolved effect can no longer be regressed

- **`putEffect` had no regression guard** (`src/durability/runtime-state.ts`,
  `src/durability/local-runtime-state.ts`,
  `src/durability/json-file-runtime-state.ts`,
  `src/postgres/persistence.ts`). Commands were already protected against
  terminal-status regression by `canReplaceCommand`, but effects were not:
  `DurableEffectRecord` carries no fencing token, so terminal-status
  monotonicity is the only ordering guarantee available, and every store
  wrote effect receipts last-write-wins. A slow `EffectReconciler` that
  returns `pending`/`unknown` writes `status: "started"`, so it could
  overwrite a concurrent `committed` resolution and silently discard the
  effect result; `ExecutionBroker.execute` would then report
  `EFFECT_OUTCOME_UNCERTAIN` for an effect that had already succeeded (and
  across replicas the receipt could flap). A `failed` receipt could likewise
  be regressed to `started`. Fixed by adding `canReplaceEffect` (a committed
  receipt may only be replaced by another committed receipt; a failed
  receipt may not become started) and enforcing it in the local, JSON-file,
  and PostgreSQL stores — the PostgreSQL upsert gains the matching `WHERE`
  clause. Verified failing-first: before the fix, a store-level
  `committed` → `started` write and a slow-`pending` reconciler racing a
  fast committed one both left the receipt at `started` with the result
  lost; both are now covered by tests (plus a concurrent-reconciler race
  test with a deterministic gated probe).

Root suite: 89/89 (86 + 3 new tests).

### ProjectCellManager concurrency and cleanup fixes; gVisor + non-root user support for project-cell services

- **Concurrent `ensure`/`lease`/`reap`/`destroy` for the same cell id
  raced** (`src/execution/kubernetes/project-cell.ts`). Two concurrent
  `ensure()` calls for a cell that didn't exist yet could each create
  their own executor sandbox — one became unreachable via `#cells` and
  leaked. A `destroy()` racing a `lease()` could delete the namespace a
  just-created cell was using, since both derive the same namespace name
  from the cell id. Fixed with a per-cell-id lock serializing all four
  operations; `reap()` re-checks idleness under the same lock a
  concurrent `lease()` would hold, so a cell that just became leased is
  never reaped out from under it. Verified failing-first with a
  deterministic race test (a gated `destroy()` that blocks mid-teardown
  while a `lease()` for the same id runs concurrently).
- **A failed `ensure()` leaked its half-built cell.** If cell creation
  failed partway through (e.g. a service pod never became ready, or the
  resource class was unknown) after the namespace/network-policy/some
  service pods were already applied, the cell was never registered in
  `#cells` — so it could never be found by `reap()` or `destroy()` and
  the partial resources were orphaned forever. Fixed by rolling back
  (destroying the executor if one was created, deleting the namespace)
  on failure — but only when this call created the namespace itself; a
  caller-supplied namespace is never deleted on failure, since it may be
  shared with other resources this call doesn't own.
- **Project-cell services couldn't run non-root-unfriendly images.**
  The cell namespace enforces `runAsNonRoot: true`, so an image whose own
  `USER` is root (most database/cache images, e.g. official `postgres`)
  fails to start with `CreateContainerConfigError`. `ProjectCellService`
  gained optional `runAsUser`/`runAsGroup`/`fsGroup` fields, wired into
  `buildProjectServicePod`, so a deployment can pin the image's intended
  non-root uid/gid instead of being unable to run it at all.

Root suite: 86/86 (78 + 8 new tests, including the concurrency race
test above).

### Fixes from adversarial testing of previously-uncovered paths (Temporal, Kubernetes workspace-sync)

Neither `integrations/temporal` nor the Kubernetes physical-execution
path (`WorkspaceSynchronizer` + `KubectlSandboxBackend`) had any test
coverage; a round of testing against a real Temporal dev server and a
real k3s+gVisor cluster found both were completely nonfunctional out of
the box, plus two smaller silent-data-loss gaps. All four fixed and
verified live, failing-first:

- **Temporal workflows could not run at all**
  (`integrations/temporal/src/workflows.ts`). `structuredClone` is not
  defined in Temporal's workflow V8 sandbox — every workflow failed
  immediately with `ReferenceError`. Fixed with a sandbox-safe JSON
  round-trip `clone()` helper.
- **The workflow could silently drop mid-turn messages and hang
  forever** (same file). A message a signal appended while an activity
  was still running got wiped by the idle-transition code
  (`state.mailbox.length = 0` cleared everything, not just what the
  turn actually consumed) — including a message that should have ended
  the loop, leaving `handle.result()` unresolved indefinitely. Fixed by
  tracking a consumed-count snapshot and removing only those messages
  (`splice`), plus waking on leftover mailbox content. Verified live: a
  9-message burst sent mid-turn (including a "finish" message) hung
  before the fix, resolved correctly after it.
- Activity failure detail was being lost behind Temporal's generic
  "Activity task failed" wrapper; added a cause-chain walk so the real
  error surfaces.
- **The Kubernetes physical-execution path failed out of the box**
  (`src/execution/kubernetes/workspace-sync.ts`,
  `kubectl-backend.ts`). The sandbox `/workspace` emptyDir is root-owned
  while the pod intentionally runs as a non-root uid; git refuses to
  operate ("detected dubious ownership") unless told otherwise, so both
  the baseline-commit step and `listGitChanges()` failed on every use.
  Fixed by scoping `safe.directory` to `/workspace` via env/`-c` (no
  filesystem writes needed, since the rest of the pod's root filesystem
  is read-only by design).
- Overlay-origin file deletions didn't round-trip through `syncBack()`:
  the Git baseline was committed before overlay changes were written,
  so an overlay-only file was untracked and its deletion invisible to
  `git status`. Fixed by committing the baseline after overlay
  materialization instead.

### Fixes from a real concurrent-load benchmark (32-256 workers, real PostgreSQL, real k3s+gVisor)

A benchmark/soak suite was run against a fresh clone of this tag: atomic
create, lease contention, command claim, mailbox throughput, project CAS,
and real-clock lease-expiry-and-takeover all held cleanly through 256-way
concurrency (100/100 or better on every contention round, 0 errors). Three
real bugs surfaced that no prior test caught, all fixed and verified
failing-first:

- **NetworkPolicy leak on every sandbox destroy**
  (`src/execution/kubernetes/kubectl-backend.ts`). `kubectl delete pod X
  networkpolicy Y` does not delete both resources — kubectl reads the
  first token as the resource type and every following token as another
  name of that same type, so it silently tries (and, with
  `--ignore-not-found`, silently fails) to delete pods named X,
  "networkpolicy", and Y. The real NetworkPolicy was never targeted and
  leaked on every destroy. Fixed with explicit `type/name` argv tokens;
  verified live against a real cluster (5 confirmed orphaned policies
  before the fix, none after).
- **Concurrent schema-install race** (`src/postgres/schema.ts`). Many
  replicas bootstrapping against a fresh database at once raced on
  Postgres's own system catalog even though every DDL statement is
  individually `IF NOT EXISTS` (`duplicate key ...
  pg_type_typname_nsp_index`). Fixed with a transaction-scoped advisory
  lock (`pg_advisory_xact_lock`) around schema install so concurrent
  installers queue instead of racing. Reproduced live: 40-way fresh
  concurrent bootstrap failed 39/40 before the fix, passed 40/40 after.
- **A 413 poisoned a reused keep-alive connection**
  (`src/inference/gateway/server.ts`). An oversized request returned 413
  without draining the rest of the body or closing the connection; the
  client's next request on that reused socket raced the leftover bytes
  and got `ECONNRESET`. Fixed by sending `Connection: close` and
  destroying the request stream on this path; reproduced live with a
  real single-socket keep-alive agent before fixing, confirmed gone
  after.

### Scaling clarification

The benchmark's first pass reported Postgres throughput saturating around
~6k ops/s at high concurrency and attributed it to the database. Re-run
against the Postgres pod's IP directly (bypassing the `kubectl
port-forward` tunnel used for the first pass) showed the tunnel itself
was the ceiling: 64 workers reached 9,052 ops/s direct vs 5,059 ops/s
through the tunnel. A follow-up partitioned-vs-hot-row comparison at
128 workers direct is the more useful number for real workloads: **11,778
fenced writes/s when each worker owns a distinct agent+lease** (the
normal shape of real usage, since fencing is scoped per-agent), versus
1,943/s when every worker contends for the same single row — which is
expected Postgres single-row lock behavior, not a runtime defect. In
short: this runtime's distributed-state layer scales close to linearly
with the workload's natural partitioning; a shared bottleneck only
appears if something is designed to hammer one row from many workers.

- Folded the abort-safety fix into the release-candidate tree: a client
  disconnecting mid-stream (`ReadableStream.cancel()`) while the upstream
  event loop was still in flight could throw an uncaught
  `ERR_INVALID_STATE` from `controller.enqueue/close/error`, crashing the
  whole gateway process, not just the one request. Fixed in both
  `streamChat` and `streamResponses` (`integrations/opencode-http-gateway/adapter.ts`)
  with an `alive` guard around every controller operation and a `cancel()`
  handler that marks the stream dead before aborting the upstream. Covered
  by a new failing-first regression test (`test/abort.test.ts`).
- Fixed a git ref/remote argument-injection issue in `NativeGitSource`
  (`src/workspace/native-git-source.ts`): a `ref` or `remote` value
  starting with `-` was passed to `git fetch`/`git remote` without an
  end-of-options guard, so an untrusted value like `--upload-pack=<cmd>`
  was parsed by git as an option rather than data. For a local-path
  remote this makes git invoke an arbitrary program on the control-plane
  host itself. Any code path that lets a task or tenant choose a workspace
  source ref was affected. Fixed with input validation (reject any
  `ref`/`remote` starting with `-`) plus a `--` end-of-options separator
  in the `git fetch` argv as defense in depth; both layers were verified
  independently to stop the injection. Covered by
  `test/native-git-source-security.test.ts`.
- Generated and committed `package-lock.json` for `npm ci` in CI and RC
  builds.
- Package version is `1.0.0-rc.1`.

### Known issues carried into this RC — all since closed

Every item originally listed here was fixed in later same-day commits;
kept as a record of what was once open, each with a pointer to its fix
(all appear chronologically above this entry):

- ~~`ChaosDurabilityProvider` does not forward `putAgentFenced`/`readEvents`/
  `pruneEvents`~~ — fixed: "Forward the optional durability surface through
  ChaosDurabilityProvider".
- ~~Tenant rate limiting is per-process only~~ — a distributed option now
  exists (`SharedTenantRateLimitPolicy` + `PostgresRateLimitStore`); see
  "Add shared cross-replica tenant rate limiting".
  `InMemoryTenantRateLimitPolicy` itself is unchanged and still per-process
  by design, for single-process deployments that don't need the shared store.
- ~~The durable event log's `pruneEvents` is not wired to named-consumer ACK
  cursors~~ — fixed: "Add durable named event-consumer ACK and safe
  retention watermark".
- ~~Project-cell service pods have no `runtimeClassName` field~~ — fixed:
  "Add gVisor support for project-cell services".
- ~~Caller-supplied Kubernetes `namespace` values aren't sanitized~~ —
  fixed: "Validate caller-supplied Kubernetes namespaces".
- ~~Bearer token comparison isn't constant-time~~ — fixed: "Compare bearer
  tokens in constant time in StaticBearerAuthenticator".

## v0.9.1-review — audit merge + second review

- Merged the external adversarial audit fixes: TS 5.9-compatible byte typing, integration syntax walker `node_modules` exclusion, empty Kubernetes runtimeClass omission, duplicate-spawn guard, and same-runtime mailbox dedup regression coverage.
- Replaced the duplicate-spawn preflight check with required `DurabilityProvider.createAgent()`, making identity creation atomic in LocalMemory, JSON-file, PostgreSQL, Chaos, and Temporal adapters.
- Changed `MailboxStore.appendMailbox()` to return `{ envelope, inserted }`; only the insertion winner steers the live engine. This closes duplicate steering across runtime replicas sharing a durable mailbox.
- Added cross-replica regression tests for both races.
- Pinned direct build devDependencies to the exact versions used by the external audit (`typescript 5.9.3`, `@types/node 22.20.4`) and stopped ignoring `package-lock.json`. A generated lockfile is still required before the final RC artifact.
- Package version is `0.9.1`.

## v0.9.0 — release hardening

- Added `AgentWriteFence` and `DurabilityProvider.putAgentFenced()`.
- `LeasedAgentRunner` now passes the active agent lease generation into `AgentRuntime.run()`.
- Durable agent-state transitions are persisted with the active fencing proof.
- Stale terminal writes fail with `AGENT_FENCE_REJECTED` and do not emit a false completed/failed terminal event.
- PostgreSQL agent writes atomically validate lease resource, owner, fencing token, and DB-clock expiry.
- PostgreSQL agent rows now store `fencing_token`; lower generations cannot overwrite higher generations.
- Unfenced PostgreSQL updates are rejected after fenced ownership starts.
- Added `LeaseStore.validateLease()` and switched `CommandCoordinator` terminal validation to it.
- PostgreSQL lease acquire/renew/release/validate now derives time from `clock_timestamp()` rather than caller timestamps.
- Added migration `deploy/postgres/003_release_hardening.sql`.
- Extended live PostgreSQL contention coverage with deliberate worker clock skew and stale-agent takeover tests.
- Added `test/v09.test.ts` and `npm run release-hardening:contract`.
- Archived the v0.8 root Markdown set under `docs/history/synth-agent-runtime-v0.8/`.

All v0.8 functionality is retained.
