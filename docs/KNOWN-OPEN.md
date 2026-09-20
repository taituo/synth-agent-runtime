# Known open items

Deliberately unfinished work, recorded so it is not silently dropped. Each item
says what is open, why it is still open, and what closing it needs. Items are
removed only when the closing work lands.

## Verification and CI

- **No CI for the Temporal integration.** Root CI runs only the root suite; the
  Temporal package's 65 unit tests and every live proof are runnable by hand
  only, so a Temporal regression can merge green. Closing: a workflow that
  starts a Temporal service and runs `tsx --test test/*.test.ts`, plus a runner
  for the live proofs that reports skipped-vs-passed per proof.
- **No enforced secret scan.** The rule is "secret-scan before every push" but
  nothing enforces it. Closing: a `scripts/secret-scan.mjs` over tracked files
  wired into CI (and optionally a pre-push hook).
- **Track 6 replay is a hand-built probe.** The replay proof uses a synthetic
  history, not a recorded history of the real `durableAgentWorkflow`. Closing:
  capture a real workflow history and replay it, asserting no non-determinism.

## Egress and artifacts

- **Workspace sync still flattens symlinks.** The git transport preserves mode
  120000, but `WorkspaceSynchronizer`/`KubectlSandboxBackend.writeFile` write
  regular bytes, and `integrations/kubernetes/git-transport-live.ts` computes
  `syncBackKind` yet excludes it from `ok`. Closing: symlink-aware
  write/list-git-changes and include the sync-back kind in the proof's `ok`.
- **`EffectResult.artifact` has no writer.** The field exists and is never
  populated, so no runtime receipt carries a digest; a canary test in
  `test/blob-store.test.ts` pins the gap. Closing: a producer on the broker or
  executor that stores content and returns the `ArtifactRef`, then remove the
  canary.
- **Blackboard `Artifact.data` is still inline.** `src/core/types.ts` keeps
  `data: unknown` (content inline), which the egress spec calls the actual work
  to fix. Closing: a breaking change to a `{digest,size,mediaType,mechanism}`
  reference, an audit of every writer/reader, a version bump and a CHANGELOG
  note.
- **Blob store has no access control or lifecycle.** Any caller can resolve any
  digest; there is no read authorization, retention, GC or write quota.
  Closing: an authz model for digest resolution plus a retention/GC policy.
- **Git-as-transport needs sandbox credentials.** Mechanism 2 requires the agent
  to push from inside the untrusted sandbox, which contradicts the existing
  "no repository credentials in the sandbox" posture. Closing: scoped/one-shot
  credentials or a broker that performs the push outside the sandbox.

## Inference and scheduling

- **Lane starvation bound is not implemented.** The spec reserves lower bands a
  fixed fraction of every window; the scheduler gives lower bands nothing while
  a higher band is backlogged. Closing: reserve a share per window, choose and
  record the number, and test it under sustained high-band load.
- **OpenRouter limits/prices are asserted, not measured.** The quota spec states
  "20 requests/minute and 50/day" and per-million prices as facts with no
  artifact. Closing: a real-key run that records the observed headers and cost,
  or removal of the numbers.
- **Rate-limit scope is still unmeasured above 80 concurrent.** The probe
  (`npm run live:rate-limit-scope`) sustained 80 concurrent calls to one cheap
  model with zero throttling and no rate-limit response headers, so the limit
  was not reached and per-model vs shared is undecided; one account also makes
  per-account and per-provider indistinguishable. Closing: a direct-upstream or
  stack-router-event probe (the gateway masks upstream 429s) at a scale above
  the observed ceiling, or provider documentation of the limit.
- **Adaptive concurrency is not built.** `LaneScheduler` takes a fixed capacity
  that is a guess with one account. Closing: the AIMD controller in
  `spec-adaptive-scarcity.md`, only after the rate-limit-scope measurement.
