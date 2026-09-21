# Changelog

## Unreleased — one production worker entry (runtime + gym), ready to scale

- **One worker.** `integrations/temporal/src/worker-entry.ts` now registers the
  runtime (`durableAgentWorkflow` + `runTurn`) AND the gym (`gymAttemptWorkflow` +
  `gymPrepareActivity`/`gymRunTurn`/`gymScoreActivity`) on one configured task
  queue; the workflows are one bundle (`src/workflows-all.ts`). The gym's turn
  activity was renamed `runTurn` → `gymRunTurn` so the two sets can share a
  worker — a worker registers one activity per type name.
- **Native scaling knobs.** `src/worker.ts` passes
  `maxConcurrentActivityTaskExecutions`/`maxConcurrentWorkflowTaskExecutions`
  (`SYNTH_WORKER_MAX_CONCURRENT_*`), Worker Deployment versioning
  (`SYNTH_WORKER_DEPLOYMENT_NAME` + `SYNTH_WORKER_BUILD_ID`), and serves
  `GET /healthz` when `SYNTH_WORKER_HEALTH_PORT` is set. `runTemporalWorker` uses
  `runUntil` with a SIGTERM/SIGINT handler, so a rollout drains in-flight work
  instead of aborting it.
- **Deployment.** `deploy/kubernetes/worker-deployment.yaml` runs 3 stateless
  replicas on one shared queue, with concurrency env, a health port and
  readiness/liveness probes, and a `terminationGracePeriodSeconds` drain window.
- **Live proof.** One `worker-entry.js` process on one task queue ran a
  `durableAgentWorkflow` triage turn and a scored `gymAttemptWorkflow` (gVisor,
  `passed`, 358 B) on the same queue, served `GET /healthz` 200, and exited 0 on
  SIGTERM.
- Docs: `docs/TEMPORAL.md` "One worker entry, N replicas";
  `docs/EXECUTION-PATHS.md` updated; `docs/KNOWN-OPEN.md` drops the "the gym runs
  its own worker" item (the residual is only the synthetic rung's in-RAM
  workspace).

## Unreleased — one scored-rung guard, applied by the gym too

- **`assertRungAllowedForScored` now has production callers.** The gym's durable
  attempt input carries `scored` (default true; `integrations/gym/run-gym.ts` and
  `integrations/gym/p2-faults.ts` set it), and `gymPrepareActivity`, `runTurn`
  and `gymScoreActivity` apply the runtime's shared guard
  (`integrations/temporal/src/gym-activities.ts`) instead of a private copy. The
  refusal is still a non-retryable `GymUnisolatedScoredRun` activity failure, but
  the message and the decision come from the shared guard.
  `assertRungAllowedForScored` now takes only the rung's isolation, so any caller
  can apply it.
- **Failing-first:** an unscored (`scored:false`) local attempt passes the
  isolation gate (it used to be refused unconditionally) and a scored local
  attempt is refused with `UNISOLATED_RUNG_REFUSED` — covered in
  `integrations/temporal/test/gym-activities.test.ts`.
- **Docs:** `docs/SCORER-SANDBOX.md` no longer says the gym's tool path needs
  routing through the runtime rung or that `SandboxWorkspaceExecutor` lacks
  `workspace.replace` (the merge made the tool path the runtime rung);
  `docs/KNOWN-OPEN.md` drops the closed "opt-in scored flag" item.

## Unreleased — fixes: a deterministic supervisor proof, honest isolation-probe labels

- **The supervisor live proof no longer races its own samples.**
  `integrations/temporal/supervisor/live.ts` used to assert the status of the
  first check-in; the tmux pane redraws on its own cadence, so that sample could
  still show the stale screen (`working.status === "idle"`) and fail a run that
  was functionally fine. It now waits (bounded, 25s) for the `working` status and
  for the `blocked` + escalation transition, and asserts those transitions rather
  than a snapshot. Ran 3× against Temporal `127.0.0.1:7244`: **3/3 `ok:true`**
  with identical quantities (`schedule.created`, `scheduleFired`,
  `blocked.escalations=1`, `redirect.delivered`, `restart.survived`,
  `scheduleRecreated`).
- **`scripts/scorer-isolation-probe.mjs` labels the actual selection.**
  The boundary label now comes from `sandboxScorerConfig()`, so
  `SYNTH_SCORER_SANDBOX=0` prints `host (Node permission model)` even when
  `SYNTH_EXECUTOR_IMAGE` is set (previously it claimed `pod (gVisor)`).
  `unconfirmed` rows now exit **2** as well, next to `reachable` — a skip or an
  unknown is never a pass. Measured exit codes: pod path **0**, host path (with
  `SYNTH_SCORER_SANDBOX=0`) **2**, unconfirmed (`SYNTH_REQUIRE_ISOLATION=1` with
  no boundary) **2**.

## Unreleased — merge `gym-runner`: one sandbox rung, consolidated FORGE attacks

- **One rung for the gym's sandbox arm** (`a6fb152`): `integrations/gym/sandbox.ts`
  now builds `ExecutionBroker([SandboxWorkspaceExecutor])` instead of the parallel
  `[SyntheticExecutor, KubernetesExecutor]`, so `workspace.read/write/replace/list`
  and `process.exec` all execute in the persistent gVisor Pod; the
  `MemoryWorkspace` is only the seed/checkpoint cache. `SandboxWorkspaceExecutor`
  gained a `workspace.replace` case (read-modify-write in the Pod, exactly one
  match), and `brokerEffectRunner.read` decodes pod bytes instead of stringifying
  them. `test/gym-sandbox-rung.test.ts` pins the executor id
  (`sandbox-workspace:sandbox-small`), the single persistent pod, and an untouched
  host sentinel.
- **Consolidated FORGE attacks** (`4a1a8d9`, `4fa32fc`): the forgery regressions
  live in `test/gym-forge.test.ts` (FORGE 1-9, including the now-discriminating
  `/proc/<ppid>/cwd` route and the `openSync` symlink variant);
  `test/gym-isolated-score.test.ts` keeps only the loop-level test. The gym CI job
  runs the attack files explicitly.
- **Verification.** Root **271 tests (269 pass, 0 fail, 2 live-gVisor skips)**;
  Temporal **104/104**; the live two-arm sandbox attempt (scripted gateway, zero
  quota) `passed` on both arms (`gvisor`, 358 B patch); the live gVisor boundary
  suite (sandbox attempt + pod boundary) 3/3 with `SYNTH_LIVE_GVISOR=1`.
- **Docs.** `docs/KNOWN-OPEN.md` drops the closed "gym sandbox is a parallel
  implementation" and "agent tool path" items (the opt-in `scored` flag remains);
  `docs/VERIFICATION.md` / `docs/VERIFICATION-LOG.md` point at
  `test/gym-forge.test.ts`; `README.md`'s test block states the merged counts.

## Unreleased — docs: label the Postgres SQL-shape proofs against the live clock proof

- **README.md** no longer says the monotonic fenced-generation behaviour is
  tested in `test/postgres-control.test.ts` "against the real database clock".
  That test is a SQL-shape test against a fake `PgExecutor` (it asserts the SQL
  uses `clock_timestamp()` and takes no worker time); the real database clock and
  worker clock skew are exercised by the live concurrency proof
  (`integrations/postgres/concurrency.ts`).
- **docs/RELEASE-GATE.md** and **docs/POSTGRES.md** no longer claim a 256-worker
  distributed-store proof. The repeatable live proof's recorded run used 16
  workers (CI sets `SYNTH_POSTGRES_WORKERS=32`); the 32-256 / 128-worker
  benchmark numbers are a historical claim in `CHANGELOG.md` with no harness or
  logs in the repo, now labelled as not reproducible here. The same unrecorded
  `256-way` figure was dropped from the `test/postgres.test.ts` schema-install
  comment.
- README's "Tests executed" block re-measured at HEAD under Node 22: root
  **277** tests (275 pass, 2 live-gVisor skips), Temporal **104/104**,
  integrations syntax **101** files, gateway **3/3**.

## Unreleased — the scoring worker runs inside the gVisor boundary

- `src/gym/sandbox-worker.ts`: when a cluster image is configured
  (`SYNTH_EXECUTOR_IMAGE`, or an injected `IsolatedScoreOptions.sandbox`), the
  scorer materializes the applied checkout into a one-shot gVisor pod and runs
  `node worker.mjs requests.json results.json` there. Only the checkout is
  mounted (no host `/tmp`, no `.git`, no `node_modules`), the pod's network
  policy is DNS-only, and its network/PID namespaces are its own — so the
  worker cannot reach Temporal/Postgres, bind a host unix socket, signal the
  verifier, or read host metadata. The verifier still holds the held-out cases
  and compares the returned values; expected values never enter the pod.
- `SYNTH_REQUIRE_ISOLATION=1` runs the pod and refuses (`errored`) when no
  boundary is configured; `SYNTH_SCORER_SANDBOX=0` forces the host path (a
  labelled development mode). The permission-model deny flags stay on the host
  path as defence in depth.
- `scripts/scorer-isolation-probe.mjs` is now boundary-aware: it checks for a
  host effect (host DB file, host socket file, the verifier PID, the host user)
  rather than a worker-local value. Red on the host worker, green in the pod.
- Control passes through the pod: `test/gym-real-task.test.ts` (golden fix
  passes, wrong fix fails, matrix) and `test/gym-scoring-hardening.test.ts`
  (config selection, `SYNTH_REQUIRE_ISOLATION` refusal).
- `docs/SCORER-SANDBOX.md` and `docs/KNOWN-OPEN.md` updated: the scoring-worker
  boundary is built; the agent's own tool path (gym `localEffectRunner` control
  arm / `SandboxWorkspaceExecutor` missing `workspace.replace`) is the
  remaining item.

## Unreleased — external review: dead weight removed, docs reconciled with the tree

- **Dead weight.** `src/observability/trace.ts` (an earlier plain `Trace` sink,
  no caller) moved to `docs/history/museum/src/observability/trace.ts` and
  dropped from `src/index.ts`; tracing is OpenTelemetry (`otel.ts`).
  `scripts/chaos-matrix.mjs` / `npm run chaos:matrix` removed: it ran the
  quarantined `dist/test/chaos.test.js`, so it exited 1, and its remaining suites
  already run in `npm test`. `docs/EXECUTION-PATHS.md` records both.
- **Measured numbers.** README's "Tests executed" block now states the suites at
  HEAD: root **276** (274 pass, 2 live-gVisor skips), Temporal **104**,
  integrations syntax **101** files, gateway **3**.
- **Stale claims corrected.** README no longer describes deleted in-memory /
  JSON-file `DurabilityProvider`s (`PostgresPersistence` is the one shipped
  provider). `docs/LIVE-PROOF.md`'s sample output and the "16 concurrent
  workers" figure were updated to the current harness and the CI value (32);
  `docs/LIVE-CONTRACTS.md` drops the retired chaos-matrix and child-process
  SIGKILL entries; `docs/KNOWN-OPEN.md` and `docs/VERIFICATION.md` no longer
  describe the gym as unmerged. `docs/RELEASE-GATE.md` and `docs/ROADMAP.md`
  no longer call shared rate limiting "verified live": it is implemented and
  tested against a fake `PgExecutor`, not the live multi-replica path.
- **Docs index.** `docs/README.md` now indexes `RUNG-PARITY.md`,
  `SCORER-SANDBOX.md`, and the historical `GYM-ONE-TURN.md` /
  `GYM-P2-RESULTS.md`.

## Unreleased — observability: one trace, native metrics, correlated logs

- **Search attributes.** `durableAgentWorkflow` upserts opt-in
  `DurableAgentState.searchAttributes` (plus `agentId`/`runId` at the start and
  `outcome` at the end). `SYNTH_SEARCH_ATTRIBUTES` lists the names/types for
  registration; a run is then queryable with
  `listWorkflowExecutions({ query: "agentId = '…'" })`.
- **Metrics.** The SDK's native Prometheus exporter serves workflow/activity
  series; `integrations/temporal/src/metrics.ts` adds `synth_model_calls`,
  `synth_model_latency`, `synth_effect_latency` (tagged kind/executor) and
  `synth_activity_retries`.
- **Tracing.** `@temporalio/interceptors-opentelemetry` (SDK plugin) spans the
  client, workflow and activity; the runtime links against `@opentelemetry/api`
  and `withSpan` (`src/observability/otel.ts`) adds `synth.engine.run`,
  `synth.model.request`, `synth.effect.execute` and
  `synth.sandbox.exec|writeFile|readFile`, so one trace reaches the pod.
- **Logs.** The activity correlation fields now include `rung`; the `runTurn`
  activity emits a correlated `synth.turn.start` line.
- `docs/OBSERVABILITY.md` documents what is emitted, how to query/scrape it, and
  the live proof `observability` (`integrations/temporal/observability-live.ts`).

## Unreleased — the legacy sweep: non-Temporal paths under Temporal

- The interactive-session supervisor is now started by a Temporal **Schedule**
  instead of by hand. `supervisor/supervise.ts` (`npm run supervisor:supervise`)
  is the operator entry: it registers a session with `ensureSupervisorSchedule`
  and starts it now with `triggerSupervisorSchedule`. The live proof
  (`supervisor/live.ts`, `live-proofs.mjs` `session-supervisor`) now creates the
  schedule, shows the schedule (not a hand `workflow.start`) started the
  workflow, delivers a redirect signal to a real tmux pane, and shows the
  schedule starts a fresh supervisor after the first ends. The
  `KNOWN-OPEN` "Schedule helper is unwired" item is closed.
- New `docs/EXECUTION-PATHS.md`: every loop/scheduler/driver in the repo marked
  PRODUCTION (Temporal) / CONTROL (labelled, refused when scored) / DEV. The
  gym's plain and `--dry-run` arms now both carry `role: "control"` and
  `isolation` in their artifacts (they already refuse `runner:"local"` for
  scored runs).
- Removed the dead homegrown lease-renewal interval
  (`src/control-plane/lease.ts` `withRenewingLease`, no caller): durable
  wait/renewal is a Temporal timer, not a host `setInterval`.

## Unreleased — durable verification and no stale compiled tests

- `scripts/live-proofs.mjs` now exits **2** when any selected proof skips
  (skip-only included), distinct from `0` pass and `1` fail. `scripts/live-proof.mjs`
  already did.
- `.github/workflows/core.yml`'s `temporal` job installs the Temporal CLI, starts
  a real `temporal server start-dev` on `:7243`, and runs the Temporal-only live
  proofs (`graph-restart`, `durable-restart`, `graph-child`,
  `graph-continue-as-new`, `graph-cancel`, `effect-receipt`). The step exits 2 if
  any proof skips, so a missing server fails CI instead of passing on skips.
- New `docs/VERIFICATION.md`: the verification standard, how to run the set, and
  the permanent regression test behind each demonstrated attack (the curated
  in-repo set; the `/tmp` review prose is scratch).
- New `scripts/verify.mjs` (`npm run verify`): root + Temporal suites, syntax,
  secret scan, and the Temporal live proofs, with 0/1/2 exit codes.
- Root `dist/` is no longer tracked (added to `.gitignore`) and the `build`/`test`
  path is `rm -rf dist` first, so a deleted test source cannot be run from a
  stale compiled artifact (the verify-7 defect). `tsc` does not prune, so the
  clean step is the guarantee; the index-only secret scan is unaffected.

## Unreleased — persist effect receipts in the shipped rung

- The Temporal rung now passes a durable `RuntimeStateStore` to
  `ExecutionBroker`: `createGatewayRunTurn` resolves a
  `TemporalActivityStateStore` from the activity context (unless one is
  injected) and hands it to the rung factory, and both the synthetic and sandbox
  rungs build `new ExecutionBroker(executors, state)`. Effect receipts therefore
  live in Temporal activity state (heartbeat details), and a retried `runTurn`
  activity starts with the committed receipts and dedupes a committed effect by
  `effect.id` instead of re-executing it. The rung's store heartbeat is also the
  turn's heartbeat, so the engine's periodic heartbeats carry the receipts
  rather than erasing them. `PostgresPersistence` remains the injectable
  `RuntimeStateStore` for a shared store.
- Failing-first: `gateway-run-turn.test.ts` retried a turn and saw the executor
  run twice before the wiring; it now runs once and the receipt is committed.
  A second test round-trips receipts through the heartbeat details and asserts a
  committed receipt cannot be regressed.
- Live `effect-receipt` proof (Temporal `:7243`, wired into
  `scripts/live-proofs.mjs`): a two-call turn fails after committing the first
  effect; the activity retries (attempts `[1,2]`), attempt 2's seed carries
  `write_file:0=committed`, and the first effect executed exactly once.
- Docs (`README`, `ARCHITECTURE`, `HARDENING`, `RECOVERY`, `DISTRIBUTED`,
  `TEMPORAL`) now state where receipts actually live.

## Unreleased — live-prove graph child workflows, continue-as-new and cancel

- Three live proofs against Temporal `:7243`, wired into
  `scripts/live-proofs.mjs`: `graph-child` (parent history shows a
  `StartChildWorkflowExecutionInitiated` for `runGraphWorkflow` with a distinct
  child run id, and the parent result embeds the child's `GraphRunState`),
  `graph-continue-as-new` (a loop of 1100 crosses the 1000-node threshold; the
  run chain shows one `WorkflowExecutionContinuedAsNew`, the final run completes
  with exactly 1100 iterations and no duplicates), and `graph-cancel`
  (`cancelGraph` stops a real loop — 3 iterations at cancel, 3 after).
- Fixed continue-as-new resumability: the threshold used the absolute completed
  count and `executeGraph` re-ran the whole graph on resume, so a resumed loop
  continued-as-new forever after one node. `GraphScope` now carries a journal of
  completed node occurrences keyed by deterministic execution path; the
  interpreter skips journaled work, a loop resumes at the first iteration not
  journaled, and the threshold counts nodes executed in the current run. Unit
  test added for the resume path.
- `docs/HARNESS.md` and `docs/KNOWN-OPEN.md` updated: child workflows,
  continue-as-new and cancel are live-proven; compensation, per-node timeouts
  and human-in-the-loop signals remain open.

## Unreleased — wire the scored-rung refusal into the turn

- `runTurn` now calls `assertRungAllowedForScored` where it resolves the rung, so
  a scored turn on the unisolated synthetic rung is refused before any model
  call. The flag is threaded from the workflow as `DurableTurnConfig.scored`,
  carried through `durableAgentWorkflow` and the graph harness like the rest of
  the turn config. This closes verify-9's finding: the guard had no production
  caller while `README`/`ARCHITECTURE` named it.
- Tests: a scored synthetic turn is refused (failing-first: the assertion was
  red before the wiring); an unscored synthetic turn and a scored isolated turn
  are the controls.
- `docs/SESSION-SUPERVISOR.md` no longer claims the unwired per-session Temporal
  Schedule (`ensureSupervisorSchedule`) guarantees a supervisor exists;
  `KNOWN-OPEN.md` records that as an open item.

## Unreleased — docs describe the current mechanism, not deleted APIs

- Rewrote the seven docs verify-7 found still telling a reader to call deleted
  code (`ARCHITECTURE`, `DISTRIBUTED`, `HARDENING`, `RECOVERY`, `RELEASE-GATE`,
  plus `CODE-REVIEW`/`TRANSACTIONS` which are purely historical and moved to
  `docs/history/`). `ARCHITECTURE.md` now describes the current runtime:
  Temporal (`durableAgentWorkflow` → `runTurn` → `GatewayAgentEngine`), the
  graph harness, the execution rung (synthetic unisolated / sandbox Pod
  workspace), the Postgres store contracts, fencing and recovery.
- `SECOND-REVIEW.md` and `SUPER.md` also moved to `docs/history/` as
  point-in-time records. The remaining historical docs carry a symbol-free
  consolidation banner. `docs/README.md` labels every doc current or historical.
- Grep for the deleted symbols (`LeasedAgentRunner`, `CommandCoordinator`,
  `AgentRuntime`, `DurableTurn`, `EffectReconciler`, `PolicyEffectGate`,
  `TemporalDurabilityProvider`, `EffectPolicy`, …) across `docs/` excluding
  `docs/history/` is empty.
- Also fixed verify-7's committed-`dist/` defect: deleted the 18 tracked
  compiled artifacts of the quarantined modules (and refreshed the rest), so a
  fresh clone's `npm test` is green without `rm -rf dist`.

## Unreleased — the sandbox rung's workspace lives in the Pod

### `workspace.read/write/list` now execute inside the boundary

- New `src/execution/kubernetes/sandbox-workspace.ts`
  (`SandboxWorkspaceExecutor`): holds a persistent Pod per workspace and runs
  `workspace.read/write/list/delete` AND `process.exec` inside it via the
  `SandboxBackend`. `MemoryWorkspace` is only a seed/checkpoint cache, never the
  read/write medium, so model-authored reads/writes are boundary-enforced.
- The sandbox rung (`integrations/temporal/src/gateway-run-turn.ts`) now builds
  `SandboxWorkspaceExecutor` per resource class and **no** `SyntheticExecutor`,
  so workspace effects cannot be served from worker RAM. The rung is cached per
  agent (the Pod outlives one turn) and checkpoints after each turn instead of
  closing.
- Durability: `checkpointSandboxWorkspace` syncs the Pod back into its cache and
  writes the workspace diff to the blob store; `restoreSandboxWorkspace` restores
  a digest into a fresh cache, which the next executor materializes into a new
  Pod. Reuses `workspace/snapshot-codec.ts`/`exportArtifact` and the blob store —
  no second store.
- The synthetic rung is explicitly `isolated: false`; the sandbox rung is
  `isolated: true`. `assertRungAllowedForScored(rung, scored)` refuses a scored
  run on an unisolated rung (the same rule as the gym's `runner:"local"` refusal).

### Evidence

- `test/sandbox-workspace.test.ts` (2 tests) with a fake Pod backend: workspace
  write/read/list run on the sandbox executor (asserts executor id and backend
  call counts), the host cache is untouched until checkpoint, a host sentinel is
  untouched, and a checkpointed workspace is restored from the blob digest into a
  new Pod. Red without `sandbox-workspace.ts` (build error), green with it.
- `integrations/kubernetes/sandbox-workspace-live.ts` — live proof against real
  k3s + gVisor (`sandbox-workspace` in `scripts/live-proofs.mjs`):
  `executor=sandbox-workspace:sandbox-small`, `readBack=pod-bytes`,
  `execOutput=pod-bytes`, cache untouched before checkpoint, `hostSentinel=
  host-untouched`, `checkpointDigest=sha256:77fffe5e…`, `ok:true`.
- Temporal suite: `assertRungAllowedForScored` refuses the synthetic rung and
  accepts the sandbox rung.

## Unreleased — provider-agnostic, config-driven backends

### Any OpenAI-compatible endpoint plugs in from configuration

- New `src/inference/gateway/provider-config.ts`: a provider is
  `{ id, baseUrl, apiKey?, model, profile? }`. `parseGatewayConfig` validates
  untrusted input; `providersFromEnv` reads `SYNTH_GATEWAY_PROVIDERS` (JSON) or
  `SYNTH_PROVIDER_<ID>_BASEURL/_MODEL/_API_KEY/_PROFILE`; `buildProviderRouter`
  constructs one `HttpGatewayBackend` per provider and groups providers that
  share a `profile` into one virtual model's failover routes. No provider and no
  key is hardcoded. `opencode-go` is one provider among many.
- `directProviderSettings(provider)` returns the `{ baseUrl, model, apiKey? }`
  that `GatewayAgentEngine` needs to call a provider **directly** — a synthetic/
  cheap run with no gateway server and no dependency on opencode or the Pi
  adapter. `selectProvider(config, idOrProfile)` selects a provider/profile.
- `integrations/temporal/src/worker-entry.ts` builds its `runTurn` from this
  config (falls back to `GATEWAY_BASE_URL`/`GATEWAY_MODEL`).

### Evidence

- `test/provider-config.test.ts` (6 tests, root suite) with local fake
  OpenAI-compatible servers: routing selects the configured provider (asserts the
  served provider id and per-provider call counts, plus the upstream-model
  rewrite); `opencode-go` is one profile among many; two providers sharing a
  profile fail over in config order; a provider is swapped in by config alone
  (same id/profile, new baseUrl — the original is not called); a synthetic run
  reaches a declared provider directly. The direct path imports no
  opencode/Pi/earendil module (grep). Red without `provider-config.ts` (build
  error), green with it.
- `docs/INFERENCE.md` documents the config; README numbers updated (root 196).

## Unreleased — quarantine the unwired modules; docs say only what is measured

### Quarantined (moved to `docs/history/museum/`, not compiled)

Every module below had zero non-test, non-barrel callers; each was moved out of
the tree and removed from `src/index.ts`.

- `src/chaos/faults.ts`, `src/chaos/wrappers.ts` — only `test/chaos.test.ts`
  named them. The one load-bearing assertion (a fault after an external effect
  leaves the receipt uncertain and blocks replay) was ported to
  `test/durable-stores.test.ts` with a plain throwing executor.
- `src/durability/local-memory.ts`, `src/durability/json-file-durability.ts`,
  `src/durability/json-file-runtime-state.ts` — in-memory/JSON durability stores
  with no production caller (Postgres is the store).
- `src/world/in-memory-world.ts`, `src/world/json-file-world.ts` — world
  implementations with no production caller. `src/world/types.ts` (the
  `WorldStore` interface) and the Postgres-backed store remain; Postgres task and
  artifact CAS is still covered by `test/postgres.test.ts`.
- `src/adapters/pi/pi-engine.ts`, `integrations/pi-runtime-bridge/`,
  `integrations/pi-synthetic-git-prototype/` — the Pi engine and bridge had no
  caller at all (the bridge was not imported anywhere). Chosen: **quarantine**,
  not wire — the bar's provider path is a direct OpenAI-compatible backend
  (`providers-1`), and wiring Pi would require the Pi packages, which are not in
  this repo. A precise re-wire spec is in `docs/KNOWN-OPEN.md`.

Kept: `src/postgres/*` (and its concurrency/fencing proof), `src/execution`,
`src/workspace`, `src/inference`, `src/gym`, `src/control-plane/{lease,mailbox}`
(interfaces used by `PostgresDistributedControlStore`), `src/durability/
local-runtime-state.ts` (used by the k8s mixed-chain proof).

### Docs

- Finished the consolidation banner across the remaining pre-consolidation docs
  (`MAP`, `SPEC`, `SUPER`, `SECOND-REVIEW`); `CHAOS.md`/`WORLD.md` now carry a
  quarantine banner; `docs/README.md` labels each doc current or historical and
  indexes `HARNESS.md`.
- Removed the live `LeasedAgentRunner`/`AgentRuntime` instructions from
  `UPGRADE.md`/`INTEGRATION.md`; README's Pi claim now states the adapter is
  quarantined. README numbers updated to the measured root 190, Temporal 89,
  syntax 81 files / 3 shell.

## Unreleased — the Temporal graph harness: loops, fan-out/join, branches

### A durable composition layer around the agent leaf

- New `integrations/temporal/src/graph.ts`: a serializable `GraphStep` — `turn`
  (the `runTurn` activity), `activity`, `child` (the agent leaf or a nested
  graph), and the composites `sequence`, `fanout` (parallel children, joined),
  `branch` (a data predicate), `loop` (iterate until a condition, durable
  counter). Conditions are `{ path, equals }` data, never closures, so the
  workflow stays deterministic. The interpreter `executeGraph` has no Temporal
  imports.
- New `integrations/temporal/src/graph-workflow.ts`: `runGraphWorkflow` runs the
  graph with Temporal handlers (`proxyActivities`, `executeChild`), exposes a
  `cancelGraph` signal and a `getGraphState` query, and calls `continueAsNew`
  after `CONTINUE_AS_NEW_AFTER_NODES` completed nodes. It adds no turn body:
  turn nodes call the same `runTurn`, child nodes run `durableAgentWorkflow`.
- `worker.ts` accepts an optional `graphActivity`; workers that only run
  `durableAgentWorkflow` are unaffected.

### Evidence

- `integrations/temporal/test/graph.test.ts` — 7 unit tests (loop-until,
  max-iterations, fan-out join, branch, nested graph, dispatch, `onNode` hook).
  Red without the interpreter, green with it.
- `integrations/temporal/graph-restart-worker.ts` — live proof: a graph
  `pre -> loop(iter ×3) -> fanout(left,right) -> hang`, SIGKILLed while `hang`
  is in flight. After recovery the per-node call counts are `pre=1`, `iter=3`,
  `left=1`, `right=1`, `hang=2`, status `completed`; committed loop and join
  nodes are not re-run. Wired into `scripts/live-proofs.mjs` as `graph-restart`.
- Documented in `docs/HARNESS.md`. Child workflows and continue-as-new are wired
  and unit-tested at the dispatch/hook level but not yet live-proven.

## Unreleased — the durable turn runs tools; durable-resume proof; verify-3 leftovers

### The `runTurn` activity can execute tool calls through the rung

- The durable turn previously never set `executeEffect`, so `GatewayAgentEngine`
  refused every tool call ("No effect executor configured"). The per-agent
  `turnConfig` (system prompt, tool surface, rung selection) now travels through
  the workflow (`DurableAgentState.turnConfig`) into the activity; the activity
  resolves the rung and sets `executeEffect` on the shared engine's context.
  There is still exactly one turn body (`GatewayAgentEngine`).
- `DurableToolSpec` maps each model tool to one execution-rung effect
  (`workspace.read/write/list/delete`, `process.exec`); `DurableRungConfig`
  selects `synthetic` (in-memory workspace) or `sandbox` (Kubernetes/gVisor via
  the existing `KubernetesExecutor`). No rung means tool calls are refused, not
  dropped. A tool-configured turn returns tool observations; the triage turn is
  unchanged and returns classifications.
- Tests: a tool-configured turn reaches the rung (executor call count 2, read
  bytes returned), the default synthetic rung round-trips a write-then-read, and
  the same turn with no rung refuses. Red before the change, green after.

### Durable-resume proof (SIGKILL `durableAgentWorkflow`)

- `integrations/temporal/durable-restart-worker.ts` SIGKILLs a worker running
  the real `durableAgentWorkflow` mid-turn and shows that committed turns are
  not re-derived: per-message activity call counts are `committedCalls=1`,
  `hangCalls=2` (attempts `[1,1,2]`), final state idle with an empty mailbox.
  Wired into `scripts/live-proofs.mjs` as `durable-restart`.

### verify-3 leftovers

- Finished the docs consolidation: `UPGRADE.md`, `INTEGRATION.md`,
  `CODE-REVIEW.md`, `RELEASE-GATE.md`, `HARDENING.md`, `RECOVERY.md`,
  `DISTRIBUTED.md`, `TRANSACTIONS.md`, `TEMPORAL.md` now carry the runtime
  consolidation banner; `TEMPORAL.md`'s redelivery rule describes Temporal's
  actual retry semantics instead of the deleted `CommandCoordinator`.
- `scripts/live-proof.mjs` now exits **2** when any check skipped (previously 0),
  matching the standing rule that a skip is never a pass.
- The executor image is pinned by digest on `main`: new
  `src/execution/executor-image.ts` (`EXECUTOR_IMAGE`,
  `ghcr.io/taituo/synth-executor@sha256:fc59ce…`) is used by the default
  resource classes and the k8s demo, and `deploy/executor-image/Dockerfile`'s
  base is pinned by digest.

## Unreleased — Temporal is the runtime; the homegrown control plane is deleted

### BREAKING: deleted `AgentRuntime` and the durable-control-plane stack

- Durability is Temporal's job. The duplicate homegrown stack is removed:
  `AgentRuntime` (`src/runtime/agent-runtime.ts`), `DurableTurn` /
  `runDurableTransactionalTurn` (`src/runtime/durable-turn.ts`),
  `transactional-turn`, `TemporalDurabilityProvider` (the dead adapter),
  `EffectReconciler`, `AgentRunner`, `CommandCoordinator`, `EffectPolicy`, and
  `Supervisor`, plus the `chaos/scenario` crash-recovery scenario that only
  existed to exercise them. `src/index.ts` no longer exports any of them.
- Every live turn now goes through the Temporal workflow and the shared
  `GatewayAgentEngine` turn body (introduced in the previous change). The
  `runTurn` activity is a thin adapter and makes no model HTTP call of its own.
- The local runner is not a runtime here; it survives only as the gym's
  labelled unisolated comparison arm (that work is on the `gym-runner` branch).
- `examples/demo.ts` now drives one turn through `GatewayAgentEngine` and the
  execution rung; `examples/kubernetes-demo.ts` drives the broker directly.
  The `AgentRuntime`-only examples and tests are archived under
  `docs/history/museum/` (not compiled by `tsconfig`).
- Postgres durability coverage is preserved and strengthened, not deleted: the
  32-worker concurrency + fencing live proof (`integrations/postgres/concurrency.ts`,
  CI `postgres-live.yml`), `test/postgres.test.ts`, and the DB-clock lease and
  hard-fenced agent-write contracts ported out of the versioned `v09` test into
  `test/postgres-control.test.ts`. Other live coverage from the versioned tests
  moved to `test/durable-stores.test.ts` and `test/inference-routing.test.ts`.
- Added `deploy/kubernetes/worker-deployment.yaml` and
  `deploy/worker-image/Dockerfile`: the Temporal worker is the only runtime
  workload; there is no homegrown control-plane Deployment. Not applied in CI.

### Tests

- Root suite: 200 passed / 0 failed (Node v22.20.0). Temporal integration
  suite: 80 passed / 0 failed. The count dropped because the versioned museum
  tests (`v03`/`v04`/`v08`/`v09`), `runtime.test.ts`, and `process-crash.test.ts`
  exercised deleted modules; their live-module coverage was salvaged first.
- Node >= 22 is required: Node 18 breaks the gym scorer's permission model and
  produces false failures in the held-out-vector tests.

## Unreleased — gym scorer: the in-process signing oracle is removed

### BREAKING: `scoreGymPatch` takes held-out `cases`, not a `hiddenTestPath`

- The pass decision used to be an HMAC over an assertion transcript, signed by a
  harness written into the clone. Agent code imported that harness and called
  `check()`/`complete()` as a signing oracle, producing a genuine MAC over a
  forged transcript and scoring `passed` with the bug unfixed (review round six,
  ONE-a, reproduced). Any signer that runs in the agent's process is reachable
  by agent code, so the signer is gone.
- The verifier (the scorer) now holds the held-out vectors and never loads agent
  code. A worker child evaluates one call per request and reports the raw return
  value on a dedicated fd; the verdict is the verifier's comparison against the
  expected value. The child's exit code is not consulted, so `process.exit(0)`
  is `errored`. The worker is confined by Node's permission model (filesystem
  reads limited to the scoring work dir) PLUS an explicit `node:sqlite` deny,
  because the model does not gate every builtin: `node:sqlite` reached and
  mutated host SQLite state regardless of the allowlist. The worker is **NOT
  isolated from the host**: measured escapes also include TCP to temporal and
  postgres, unix-socket binds outside the clone, `process.kill` against the
  verifier, and `os.userInfo` host metadata (`scripts/scorer-isolation-probe.mjs`).
  The permission model is a GUARDRAIL, not a security boundary. Real isolation
  needs an OS-level boundary, which is required but not built — see
  docs/SCORER-SANDBOX.md. If no permission model exists, or `node:sqlite` is
  present with no way to deny it, the scorer refuses to run rather than fail
  open. There must be ONE boundary for all agent-controlled execution (the
  scorer's worker and the agent's tool execution); `SYNTH_REQUIRE_ISOLATION=1`
  makes the scorer refuse the unscoped host path for deployments that require it.
- `ScoreGymPatchOptions.hiddenTestPath`/`expectedHiddenTests` are replaced by
  `cases: GymCase[]`. The `he/decimal-option` task fixture ships
  `hidden.cases.json` in place of the in-clone TAP test. The `HIDDEN_HARNESS_*`
  exports are removed.
- A patch could plant a leaf symlink inside the checkout pointing at the
  held-out vectors; Node's permission model follows the link before deciding, so
  the read was allowed and the bug scored `passed`. The scorer now resolves every
  symlink in the applied checkout and returns `tampered` if any escapes it (or is
  broken) before the worker starts. A worker cannot create a link at runtime
  because it has no write permission.
- Every demonstrated forgery is a permanent regression test in
  `test/gym-vacuity.test.ts` (FORGE 1-8, including the signing oracle, the
  `/proc/<ppid>/cwd` vector read, the leaf symlink, and the `node:sqlite` host
  escape).

## 1.0.0-rc.1 — abort-safety fix folded in, git ref/remote argument-injection fixed

### BREAKING: `Artifact.data` is now `Artifact.ref` (+ bounded `inline`)

- The world store is where artifacts land, and it carried `data: unknown`
  inline — content on the blackboard, which the rest of the system forbids
  (references, never bytes). `Artifact` now carries `ref: ArtifactRef`
  (`digest`/`size`/`mediaType`/`mechanism`, with `producedBy`/`producedFrom` for
  provenance), and `MemoryWorkspace.exportArtifact(store)` writes the encoded
  diff to a `BlobStore` and returns the reference. `decodeWorkspaceDiff` recovers
  the changes from the digest. A small-inline escape hatch is kept but explicit:
  `Artifact.inline` is opt-in and bounded by the same `MAX_INLINE_SNAPSHOT_BYTES`
  ceiling as the snapshot path; over the ceiling it throws
  `INLINE_ARTIFACT_TOO_LARGE` and the reference is the only carrier.
- Writers and readers were enumerated first: the only production writer was
  `exportArtifact` (plus the demo), and the only readers were the world-store
  persistence and two tests. Callers that constructed an `Artifact` with `data`
  must construct a `ref` (and optionally a bounded `inline`).

### Blob store: an access model and a lifecycle primitive

- The blob store had no stated access model, so any caller could resolve any
  digest. Decided and implemented: within one trust domain the digest IS the
  capability (256-bit, unguessable, and `get` re-hashes so integrity is verified
  on every read) — that is why unrestricted read by digest is acceptable here.
  Across tenants it is not, so `GuardedBlobStore` + `TenantBlobPolicy` enforce
  isolation: a read requires the owning tenant, `stat` returns undefined rather
  than leaking existence, and writes require a principal. `list`/`prune` add a
  lifecycle primitive (reachability is the caller's job). Decision, rationale
  and remaining gaps in `docs/BLOB-STORE.md`.
- **The three lifecycle gaps named in `docs/BLOB-STORE.md` are closed.**
  `reachableDigests` + `sweepUnreferencedBlobs` (`src/artifacts/retention.ts`)
  wire `prune` to the artifact index's reachable set, including the
  `producedFrom` ancestry and referenced-but-unrecorded digests, with an
  optional grace period. `TenantWriteQuota` enforces a per-blob size ceiling and
  a per-tenant cumulative ceiling in `GuardedBlobStore.put` (new objects only,
  so dedup is not charged twice, and a rejected write is not charged). Read
  auditing emits a `BlobAuditEvent` (op, digest, outcome allowed/denied/
  not-found, principal, at) on every `get` and `put`. The quota counter is
  in-memory; durable accounting is the caller's if needed.

### Lane scheduler: a lower band can no longer be starved

- The spec reserves lower bands a fixed fraction of admissions, but the
  scheduler always preferred the highest backlogged band, so a saturated high
  band could starve a lower one indefinitely. Add `lowerBandReserveFraction`
  (default 0.2): credit accrues on every admission and is spent on a reserved
  lower band, so a backlogged lower band receives roughly its share. Tests
  assert the BOUND — a low-band request is admitted within ~1/fraction
  high-band admissions, not merely eventually — and the sustained-contention
  share; failing-first with the reservation removed.

### Git-as-transport: scoped, one-shot sandbox push grants

- Mechanism 2 needs a credential inside the untrusted sandbox. Added
  `createScopedPushGrant` plus a `pre-receive` hook on the runtime-controlled
  bare repo: a push must be exactly one NEW ref matching an unexpired grant;
  deletes and force/overwrite are rejected; the grant is consumed, so it is
  one-shot. The sandbox carries only the transport secret; authorization is the
  grant plus the hook, so a stolen credential can create the granted ref once
  and nothing else. Residual risk (transport scope, untrusted content,
  exfiltration, read access) is stated in `docs/GIT-PUSH-CREDENTIALS.md`. Tests
  run against real git; failing-first with the hook neutered.

### Gym: the completion marker is cryptographic, not held out

- `passed` was decided by a per-run nonce the hidden test printed, which agent
  code could read from the process it runs in (`/proc/self/environ` survives
  deleting an env var). The decision is now an HMAC over the transcript of
  assertion outcomes: the hidden harness reads a per-run key from a file and
  DELETES the file and its env pointer before the agent's module is imported,
  then signs the transcript; the scorer, which holds the key, verifies it. The
  key is not observable in env, argv or on disk when the agent runs, so a forged
  or absent result cannot authenticate. Tested with an agent that reads its own
  environ and the hidden test source and forges a result — it scores `errored`.

### Gym scoring: score the diff, against a test the agent never sees

- **The gym's first half is the scoring pipeline** (`src/gym/scoring.ts`): apply
  the agent's patch to a fresh checkout of the pinned commit, copy in a
  held-out test the agent never sees, and record one of `passed`, `failed`,
  `tampered`, `timed-out`, `errored`, `skipped`. A diff that touches test files
  or runner config is `tampered`, not `failed`. Path extraction uses git's own
  parser (`git apply --numstat -z`) plus both sides of renames and the
  `---`/`+++` headers, so a hand-crafted patch cannot hide a protected path.
- **`passed` is not "node exited 0".** The hidden test imports the
  agent-controlled module, so a top-level `process.exit(0)` or an `assert`
  monkeypatch would otherwise score green — `node --test` even marks an early
  exited-0 file as a passing subtest. `passed` now requires a real TAP summary
  with zero failures, the expected number of passing subtests, and a per-run
  completion marker the hidden test prints only after its assertions. `assert`
  is frozen before agent code loads, and a hidden test that runs no assertions
  is `skipped`/`errored`, never `passed`.

### Gym end-to-end runner: plant the bug, run both arms, harvest, score

- **The scoring half of the gym now has a runner half.** `src/gym/task.ts`
  materializes a checked-in task fixture (`test/fixtures/gym-tasks/<repo>/<slug>/`)
  into a **committed bugged checkout**: clone the pinned commit from the local
  fixture cache, plant the read-only visible test, apply `bug.patch`, and commit.
  `baseRepoDir` is therefore the bug, not clean upstream — an unrelated no-op
  patch scores `passed` against the clean commit and `failed` against the bugged
  one, which is the trap this step exists to avoid. `goldenReversePatch` produces
  the bug's own reverse patch, which scores `passed`. The first real task is `he`
  `hex-decode` (hex numeric character references decoded in base 10).
- **`src/gym/tools.ts`** is the agent tool surface (`list_files`, `read_file`,
  `write_file`, `replace_in_file`, `run_visible_test`, `finish`) defined over an
  `EffectRunner` so the identical definitions run over a local temp dir or the
  `ExecutionBroker`; `write_file`/`replace_in_file` refuse test files and runner
  config, and an unknown tool is a recoverable observation rather than a crash.
  The prompt advertises every tool, so a model cannot silently reach for one the
  harness does not have.
- **`src/gym/harvest.ts`** takes the patch from git (`git add -A` + `git diff
  --cached HEAD`) with `node_modules` explicitly excluded, so sandbox-only side
  effects never travel with the scored patch.
- **`src/gym/attempt.ts`** is the single shared loop both arms call; the only
  injected difference is the runner and the turn. It returns the milestone's
  record (five outcomes, requested/served model, substitution flag, wall time,
  call count, protected paths touched) and exposes scoring as one injectable seam.
- Plain turn (direct gateway), durable `gymAttemptWorkflow` (park/backoff shape,
  sandbox broker + `KubernetesExecutor`), and `integrations/gym/run-gym.ts` whose
  `--dry-run` completes the whole pipeline at **zero model calls**. A transient
  turn failure (5xx, 429, timeout) is surfaced as a structured `GymFailure`, so
  the durable activity throws and Temporal retries then parks on the server's
  `Retry-After` hint while the plain arm does neither. A malformed/truncated
  model reply is `malformed`, not `transient`: the runner re-asks it exactly
  once (`maxReasks`, default 1) on a budget separate from the durable retry
  path, so a stochastic formatting slip recovers but a model that reliably emits
  bad JSON cannot consume the retry allowance every turn.
  `integrations/gym/p2-faults.ts`
  runs the per-arm fault matrix (502, 429, timeout, worker restart, SIGKILL)
  with a fresh fault proxy per arm so a one-shot fault is not consumed by the
  first arm. The durable arm's workflow input now carries the gateway `apiKey`
  too, so an authenticated gateway sees the same request from both arms; without
  it the plain arm sent `Authorization` and the durable arm did not, varying more
  than durability. Note the provider-fault rows (502/429/timeout) are
  retry-policy rows, not durability evidence: the plain arm is a no-retry single
  shot, so they measure "has any retry at all". The process-fault rows are the
  durability evidence.
- **Work-product checkpoints close the "control-plane durability is not
  work-product durability" gap found by the fault matrix.** A SIGKILLed worker
  used to leave the retried activity re-materializing the pinned bugged checkout,
  discarding the agent's edits (observed: a resumed attempt reading the bugged
  source at turn 0 and producing a 0-byte patch). `src/gym/checkpoint.ts` saves a
  `git diff` patch plus the transcript after every turn as a content-addressed
  blob (pointer file for discovery, previous digest as `producedFrom` for
  provenance), and `runGymAttempt` restores the latest checkpoint and resumes
  from the next turn. A patch is O(delta) per turn rather than a full-repo
  bundle, which is the right unit for in-progress state; the git transport's
  mode/symlink fidelity remains for final egress. The SIGKILL measurement shows
  **re-application, not re-derivation**: a checkpoint can already contain the
  finished fix, so a resumed attempt that only calls `finish` scores `passed`.
  The stronger claim — the resumed attempt makes new edits rather than replaying
  — is measured by `stronger claim: with a non-fixing checkpoint the resumed
  attempt must make the edit` in `test/gym-checkpoint.test.ts`, not by the
  headline 4/4.
- **The gym pass decision is now unforgeable: it is made where the agent's code
  cannot run, reach or observe it.** `src/gym/scoring.ts` runs the agent
  module in a separate worker that is given one input per request and never sees
  an expected output or a secret; the verifier (which never loads agent code)
  holds the test vectors and decides by comparing returned values. The child's
  exit code is not consulted, so `process.exit(0)` before assertions is
  `errored`, not `passed`, and there is no `GYM_HIDDEN_NONCE` in the child's
  environment to read. Zero cases is `errored`, never a vacuous pass. The
  fixture's held-out vectors live in `hidden.cases.json`; a task with them always
  uses the isolated scorer. Regression tests pin the exact fifth-round forges
  (nonce read, early exit, constant stub, assert mutation) and the control
  confirms the legacy in-process scorer still passes the early-exit forge while
  the isolated scorer rejects it.
- **Combined-tree decision: the isolated verifier is the gym's pass decision.**
  Main's harness scorer and this one were merged and initially collided: a plain
  held-out test scored by the harness scorer is `errored`, so the golden control
  failed (rejects-everything). The two are not equivalent. The harness scorer
  places `check`/`complete` in the clone and runs agent code in the same process
  as the hidden test, so agent code can `import` the harness, record its own
  passing checks, call `complete()`, and exit before the real checks run —
  executed against the merged dist, that scores `passed` with the bug unfixed.
  A same-process decision cannot be sound when the adversary runs in that
  process. `runGymAttempt` therefore routes every scored task through
  `isolatedScoreGymPatch` (held-out cases, agent code in a worker that never
  sees the expected outputs or a secret) and a task without cases is `errored`,
  not silently handed to the harness scorer. Main's `scoreGymPatch` remains a
  library for its own hidden-test-file tests; it is not the runner's decision.
- **The isolated worker is now filesystem-sandboxed against the ground truth.**
  Review round six ONE-b: the worker ran unsandboxed on the same host, so agent
  code located the verifier's cwd through `/proc/<ppid>/cwd`, read the held-out
  vectors (`hidden.cases.json`) off disk, and passed every case with the bug
  untouched. The worker now runs under Node's permission model with `fs` reads
  allowed only inside the scoring work directory (the clone and the worker
  script); the fixture tree and `/proc/<ppid>` are outside it and denied, and if
  the runtime has no permission model the scorer refuses to run rather than fail
  open. Permanent regressions: `FORGE 5` (read the vectors by absolute path) and
  `FORGE 5b` (the exact `/proc/<ppid>/cwd` route against the real `he/hex-decode`
  vectors), plus a regression that a case-less task is `errored` rather than
  falling back to the exit-code scorer (round-six FOUR). The signing-oracle
  forgery against the same-process harness scorer (`ONE-a`) is covered at the
  gym-decision level by `FORGE 4`; that library remains the reason it is not the
  decision.

### Model visibility: never guess which model answered

- **The answering model is recorded as it happened.** `GatewayTurnRecord` now
  carries `requestedModel` and `servedModel` separately, with
  `modelSubstituted` when the upstream names a different model; an upstream that
  omits the field is recorded as unknown, never back-filled with the requested
  id. A hardcoded `modelIds` filter in a probe host had made 27 available models
  look like one, and every accuracy/latency figure was that single model's.
  Discovery is no longer filtered (authorization belongs in the gateway's tenant
  policy), and `npm run models:list` prints the catalog with provider/profile.
  Live: the unfiltered adapter lists all 27 models, with zero quota spent.

### Verification fixes: a third copy removed, dead claims retired

- The Temporal integration's retry-hint parser was a third copy; the canonical
  parser lives in `src/inference/gateway/retry-hint.ts`, the router and the
  integration use it, and the stack-router's standalone copy is pinned by a
  parity test over shared header sets.
- Fault-matrix `proven` rows now require evidence recording an executed run and
  a runnable artifact, not a `.test.ts` filename; the six provider rows were
  never measured under both rungs and are now `reasoned`.
- The real-429 driver asserts the park tracks the parsed hint, not merely that
  the agent parked. A lane-scheduler property test covers arrival streams. The
  blob-store "receipt digest" test, which proved only the store round-trip under
  a receipt name, is replaced by an explicit known-open canary.
- The corpus baseline was withdrawn and re-measured. Four `cve-*` items had been
  reclassified to `news` to agree with one model — tuning the measure — and a
  second model disagreed; they are now `ambiguous` (excluded from accuracy,
  kept for structural checks). The scorable set is 8, all three measured models
  score 8/8 = 1.0, and the gate is documented as a smoke test, not a benchmark.

### Durable session supervisor

- **A Temporal workflow now supervises interactive agent sessions** instead of a
  hand-re-armed 30-minute monitor that scraped tmux for `esc interrupt` and
  could silently fail to deliver a message. One workflow per session, durable
  check-in timers, signals for `redirect`/`pause`/`resume`/`stop`, escalation
  when a session stays blocked past a threshold, and a per-session Temporal
  Schedule that re-creates a supervisor if it dies. It runs on a **separate**
  Temporal (default `:7244`), so restarting the system under test cannot take
  its own supervisor down. Probes prefer a real state signal (herdr) and fall
  back to a labelled tmux scrape; every poke is verified, never assumed. Live
  proof: real tmux pane, escalation delivered, redirect delivered, and a worker
  SIGKILL + restart the workflow survived. See `docs/SESSION-SUPERVISOR.md`.

### Artifact handoff by reference, with provenance and a flat history

- **Artifacts now carry provenance and can be handed onward without bytes
  crossing a boundary.** `BlobRef`/`ArtifactRef` gained `producedBy` and
  `producedFrom` (input digests), stored in the blob store's sidecar and
  round-tripped by `stat`. A new `InMemoryArtifactIndex` is queryable by digest,
  producer and input digest, and `walkProvenance` returns a **report** — nodes
  with `known`, plus `gaps`/`truncated`/`intact` — rather than a bare digest
  list, so a broken chain (an ancestor named by `producedFrom` but never
  recorded) is distinguishable from an intact one instead of silently giving
  false confidence. `createReviewRef`/`listReviewRefs` expose a producer's
  commit at a fully-qualified `refs/synth/<agent>/<run>` a reviewer can fetch
  and diff. The live proof (`npm run live:handoff`) has agent A produce an
  artifact and agent B — a **different workflow** — receive only the reference
  by signal, read exactly those bytes by digest, and derive a new artifact whose
  `producedFrom` points back at A; the provenance chain B→A→input is walkable,
  and the Temporal history size stays **flat** (delta 12–23 bytes) across a 1 KiB
  vs 4 MiB artifact — the assertion that actually tests "never inline content".

### Artifact egress: content-addressed blob store and git transport

- **Getting artifacts out of a sandboxed run had one weak path** (the inline
  base64 workspace snapshot) and no out-of-band mechanism. Added the first two
  mechanisms from `docs`/the egress spec. A `FileSystemBlobStore`
  (`src/artifacts/blob-store.ts`) stores content by `sha256`, returning a digest
  reference (`{digest, size, mediaType, mechanism}`); identical content
  deduplicates to one object, writes are atomic (temp + rename), and `get`
  verifies the digest so a corrupted object raises `BLOB_CORRUPT` instead of
  returning wrong bytes. Git as the transport (`src/workspace/git-transport.ts`)
  ingests a `git bundle` the sandbox produces on stdout (base64, since
  `kubectl exec` stdout is text) into a runtime-controlled bare repo. This is
  the only mechanism that preserves file modes and symlinks, which the workspace
  sync path flattens. Tests: a bundle round-trip over real git asserts the tree
  hash equals git's and that a symlink (120000), an executable bit (100755) and
  an unusual filename survive; a live gVisor proof
  (`integrations/kubernetes/git-transport-live.ts`, `npm run git-transport`)
  round-trips the pinned commander repo through a sandbox exec that modifies it
  and gets the same tree hash back (`a2fd30e2…`), with all three shapes intact.
- **The workspace sync path preserves symlinks now too, closing the gap the
  sentence above used to name.** `WorkspaceSynchronizer` materializes source and
  overlay symlinks with `writeSymlink` instead of following them into regular
  bytes; `SandboxBackend` gained `writeSymlink`/`readSymlink` and `listGitChanges`
  reports `symlink`; `syncBack` records a link in the `MemoryWorkspace` rather
  than the bytes it points at. The live proof previously computed
  `workspaceSyncKindForSymlink` and excluded it from `ok`, and because the
  sandbox committed its changes `git status` against HEAD saw none, so it
  measured nothing (`null`, `ok:true`). It now creates an uncommitted symlink and
  requires `workspaceSyncKindForSymlink === "symlink"`, and checks commander's
  own `tests/fixtures/another-dir/pm` link inbound. Live gVisor run:
  `inboundSymlinkPreserved:true`, `workspaceSyncKindForSymlink:"symlink"`,
  `workspaceSyncTarget:"regular-new.txt"`, `ok:true`.

### Priority lanes wired into the gateway request path

- **Scarce subscription quota had no scheduling decision.** Added a pure,
  clock-injected `LaneScheduler` (`src/inference/gateway/lane-scheduler.ts`):
  strictly-ordered priority bands, deficit weighted round-robin fair-share
  within a band, queue-or-reject with a lane `maxWaitMs` deadline, and a
  `retryAfterMs` estimate. A `PriorityLanePolicy` admits each gateway request
  through it; `GatewayPrincipal` gained an optional `lane`, and
  `GatewayTenantPolicy` an optional `release()` hook. The gateway server now
  frees the slot when an authorized request finishes (so the next queued request
  is admitted in band order) and propagates the lane's `retryAfterMs` as an HTTP
  `Retry-After` header on a 429. This is the first time the scheduler can affect
  a real request: the live proof (`npm run live:lane-gateway`) starts the real
  gateway in front of a slow backend and fires concurrent requests tagged to
  different lanes — a batch request holds the single slot, a later interactive
  request overtakes an earlier queued batch one (completed 1227 ms vs 1827 ms),
  and a request past its 150 ms lane deadline is rejected `429` with
  `Retry-After: 1`. Failing-first: forcing FIFO in the scheduler made the live
  proof report `interactiveOvertookBatch: false`.

### Synthetic rung parity with the real filesystem

- **The synthetic rung (fidelity 0, `MemoryWorkspace`) returned `ok:true` where
  a real filesystem fails**, so a cheap in-memory run could teach something
  false: reading, deleting or listing a missing path all succeeded silently, a
  directory delete left its children readable, writing under a file path
  succeeded, and a `..` path was silently rewritten to a different in-workspace
  path. Added a differential harness (`test/rung-parity.test.ts` +
  `test/fixtures/rung-parity.ts`) that runs seeded effect sequences against both
  the synthetic rung and a real-filesystem executor (the oracle) and diffs the
  per-effect outcome, plus a shared error vocabulary
  (`src/execution/workspace-errors.ts`) so both rungs return the same `error`
  string. `SyntheticExecutor` now returns `WORKSPACE_NOT_FOUND` /
  `WORKSPACE_NOT_DIRECTORY` / `WORKSPACE_IS_DIRECTORY` / `WORKSPACE_PATH_ESCAPES`
  instead of silent success; `MemoryWorkspace` gained `stat`, recursive
  directory deletion and implicit-directory tracking, and a path normalising to
  the root is now an `EffectResult` rather than a thrown exception. The harness
  found three further divergences beyond the six reported (implicit
  directories, `ENOTDIR` on read/list/delete under a file, `EISDIR` on write
  over a directory), all fixed. What can and cannot be trusted on the synthetic
  rung is documented in `docs/RUNG-PARITY.md`.

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
