# Changelog

## 1.0.0-rc.1 — abort-safety fix folded in, git ref/remote argument-injection fixed

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

### Known issues carried into this RC (not blockers, tracked for follow-up)

- `ChaosDurabilityProvider` (`src/chaos/wrappers.ts`) does not forward the
  optional `putAgentFenced`/`readEvents`/`pruneEvents` members, so wrapping
  a fencing-capable provider (e.g. Postgres) for chaos testing makes every
  fenced write fail with `FENCED_AGENT_WRITE_UNSUPPORTED` regardless of the
  inner provider's real capability. This only affects the chaos-testing
  harness itself, not production write paths. Fix: forward those methods
  when `inner` implements them, mirroring the existing pattern already used
  for `claimCommand`/`claimEffect` in `ChaosRuntimeStateStore`.
- Tenant rate limiting (`src/inference/gateway/tenant-policy.ts`,
  `InMemoryTenantRateLimitPolicy`) is per-process only; there is no
  distributed counterpart, so a tenant's effective limit scales with
  replica count in a horizontally-scaled gateway deployment.
- The durable event log's `pruneEvents(throughSeq)` is not wired to
  mailbox named-consumer ACK cursors: `throughSeq` is caller-supplied, so
  nothing today computes a safe watermark from consumers' actual read
  positions before pruning. A caller could prune events a lagging
  consumer hasn't read yet. See `docs/RELEASE-GATE.md`.
- Project-cell service pods (`buildProjectServicePod` in
  `src/execution/kubernetes/manifests.ts`) have no `runtimeClassName` field
  and never run under gVisor, unlike sandbox executor pods.
- Caller-supplied Kubernetes `namespace` values (`project-cell.ts`,
  `kubectl-backend.ts`) are not sanitized the way derived pod/service names
  are; no current in-repo caller passes untrusted data here, but embedders
  deriving `namespace` from tenant input should sanitize it themselves for
  now.
- Bearer token comparison (`StaticBearerAuthenticator`) is a plain string
  equality check, not constant-time.

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
