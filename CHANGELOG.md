# Changelog

## 1.0.0-rc.1 — abort-safety fix folded in, git ref/remote argument-injection fixed

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
