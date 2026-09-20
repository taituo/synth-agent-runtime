# Known open items

Deliberately unfinished work, recorded so it is not silently dropped. Each item
says what is open, why it is still open, and what closing it needs. Items are
removed only when the closing work lands.

## Runtime and deploy

- **Per-run provider selection is an API, not yet threaded through the turn
  config.** `provider-config.ts` exposes `selectProvider`/`directProviderSettings`
  so a run can pick a provider/profile, and the worker selects one provider at
  startup. A single worker does not yet route different agents to different
  providers per turn: `DurableTurnConfig` carries the model but not a provider
  id. Closing: add a provider/profile id to `DurableTurnConfig` and have the
  activity resolve it per turn (one worker, many providers).

- **Pi is quarantined, not wired.** `PiAgentEngine` and
  `integrations/pi-runtime-bridge/` had no caller and are in
  `docs/history/museum/`. Re-wiring them as the harness would need the Pi
  packages (not in this repo) and would have to route turns through the shared
  `GatewayAgentEngine`/`runTurn` path rather than a second turn body. Until then
  the provider path is a direct OpenAI-compatible backend. Closing: a
  `harness-1`-scale change with the Pi session as an `AgentEngine` whose model
  calls go through the one turn body, plus a live proof.
- **`src/workspace/transaction.ts` is uncalled but protected.**
  `WorkspaceTransaction`/`withWorkspaceTransaction` have no caller (test or
  production). The task boundary protects `src/workspace`, so it was kept rather
  than quarantined. Closing: wire it into the turn's workspace commit path or
  quarantine it with the boundary lifted.

- **The graph harness is not fully live-proven.** `docs/HARNESS.md`'s graph
  workflow runs loops, fan-out/join and branches; the loop+join path has a live
  SIGKILL/restart proof (`graph-restart`). Still only unit-tested: child
  workflows as live child runs, `continueAsNew` at the threshold, `cancelGraph`
  against a real long loop, and per-node timeouts/compensation. Closing: a live
  proof per mechanism, asserting call counts.

- **The Temporal worker deploy shape is documented, not enforced.** Temporal is
  now the single durable engine and the homegrown control plane is deleted
  (`CHANGELOG.md`, Unreleased). `deploy/kubernetes/worker-deployment.yaml` and
  `deploy/worker-image/Dockerfile` describe the one worker workload, but no CI
  job applies them: the cluster has no per-push coverage, so the manifest can
  rot. Closing: a self-hosted runner job that applies the manifest against a
  throwaway cluster (the same gap as the gVisor/Pi proofs below).
- **The worker entry point still defaults to triage; the gym task layer is on
  `gym-runner`.** `integrations/temporal/src/worker-entry.ts` wires the `runTurn`
  activity to the event-triage turn. The durable turn now executes tools through
  the rung when an agent's `turnConfig` supplies a system prompt, tool surface
  and rung (see `CHANGELOG.md`, Unreleased), but `main` has no task
  materialization/checkpoint layer: the synthetic rung's workspace lives for the
  worker process's lifetime and does not survive a worker restart. The gym's
  coding activity, task materialization and checkpoint store live on the
  `gym-runner` branch and are not on `main`. Closing: merge that layer, or port
  the gym activity onto the shared `turnConfig`/rung path here.

## Egress and artifacts

- **Workspace sync still flattens symlinks.** The git transport preserves mode
  120000, but `WorkspaceSynchronizer`/`KubectlSandboxBackend.writeFile` write
  regular bytes, and `integrations/kubernetes/git-transport-live.ts` computes
  `syncBackKind` yet excludes it from `ok`. Closing: symlink-aware
  write/list-git-changes and include the sync-back kind in the proof's `ok`.
- **Blob store: access model decided, lifecycle partly wired.** The decision is
  in `docs/BLOB-STORE.md`: within one trust domain the digest is the capability
  (unguessable, integrity-verified on read), and across tenants
  `GuardedBlobStore` + `TenantBlobPolicy` enforce isolation (with `stat` not
  leaking existence). `list`/`prune` exist and are tested. Still open:
  automatic GC wired from the artifact index's reachable set, a per-tenant write
  quota, and read auditing. Closing: a scheduled retention job, a `put` size
  ceiling, and an audit event on `get`.


## Gym scoring isolation

- **The scoring worker is NOT isolated from the host.** Node's permission model
  is a guardrail, not a boundary: review round six enumerated six capability
  classes that escape it. Measured by `scripts/scorer-isolation-probe.mjs`
  against the real worker: `node:sqlite` is now blocked, but **TCP to temporal
  `:7243` and postgres `:5432` connect, a unix socket can be bound outside the
  clone, `process.kill` can signal the verifier, and `os.userInfo` returns host
  metadata**. So a gym run can reach the very services we measure with and can
  mutate host state independent of the verdict. Denying builtins one at a time
  has no finite end. A deployment that requires isolation can set
  `SYNTH_REQUIRE_ISOLATION=1`, which makes the scorer refuse rather than run on
  the host — but the real fix is the single boundary below. The agent's own tool
  path (`localEffectRunner`) is worse: no permission model at all.
  Closing: run the worker in an OS-level sandbox with only the clone
  bind-mounted and no host `/tmp` (a mount namespace, `unshare`/`bwrap`, or the
  existing gVisor rung), so confinement does not depend on a builtin allowlist.
  Plan and measured feasibility: `docs/SCORER-SANDBOX.md`. Until then, the
  scorer must not persist expected values, case data or secrets anywhere a path
  from the worker can name — a SQLite file would reopen the forgery channel.

## Measurement

- **The corpus is a smoke test, not a benchmark.** The four `cve-*` items were
  moved to `ambiguous` (a vulnerability report is both `news` and `incident`),
  so the scorable set is 8 items; all three measured models score 8/8 = 1.0
  (`CORPUS_BASELINE`). Eight items is too few to gate on meaningfully — 7/8 =
  0.875 already fails a 0.9 gate, so the gate detects regressions, not
  capability. Closing: a corpus on the order of 100+ items, balanced across
  classes, with labels agreed by more than one annotator and the ambiguous set
  reported separately.

## Inference and scheduling

- **OpenRouter limits/prices are UNMEASURED and stay labelled so.** The quota
  spec (external, `/tmp/opencode/spec-quota-aware-retry.md`) states "20
  requests/minute and 50/day" and per-million prices as facts, with no artifact
  behind them. We do not have an `OPENROUTER_API_KEY`, so we cannot measure
  them. They must not be cited as measured; the driver itself skips with exit 2
  when the key is absent. Closing needs a real key and a run that records the
  observed headers and cost — until then the numbers are unverified claims, not
  results.
- **Rate-limit scope: no practical limit binds at our scale (measured).** The
  probe (`npm run live:rate-limit-scope`) sustained **1000 concurrent** calls to
  one cheap model: 998 returned 200 in ~20s (~50 req/s), 2 returned a transient
  5xx ("Stream ended without finish_reason" / "503 status code (no body)"), and
  there were **zero 429/402 responses and no rate-limit headers**. A second
  model was unaffected immediately after. So the provider did not throttle at
  ~3000 req/min-equivalent on this tier, and the observed failures are transient
  provider errors under a huge simultaneous burst, not rate limiting. Per-model
  vs shared stays undecidable without ever hitting a limit; one account also
  makes per-account and per-provider indistinguishable. Consequence: adaptive
  concurrency is **deprioritised** — do not build a controller for a constraint
  that does not bind. Revisit only if a limit appears at higher sustained load
  or on a paid tier.
- **Adaptive concurrency is deprioritised, not built.** `LaneScheduler` takes a
  fixed capacity, but the rate-limit-scope measurement found no practical limit
  at our scale (1000 concurrent, no throttle), so an AIMD controller would have
  nothing to discover. Revisit only if a limit appears; the measurement is in
  the rate-limit-scope entry above.
