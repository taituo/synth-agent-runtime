# Known open items

Deliberately unfinished work, recorded so it is not silently dropped. Each item
says what is open, why it is still open, and what closing it needs. Items are
removed only when the closing work lands.

## Verification and CI

- **Track 6 replay is a hand-built probe.** The replay proof uses a synthetic
  history, not a recorded history of the real `durableAgentWorkflow`. Closing:
  capture a real workflow history and replay it, asserting no non-determinism.

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
- **Git-as-transport needs sandbox credentials.** Mechanism 2 requires the agent
  to push from inside the untrusted sandbox, which contradicts the existing
  "no repository credentials in the sandbox" posture. Closing: scoped/one-shot
  credentials or a broker that performs the push outside the sandbox.

## Gym

- **The completion-marker protocol is held out, not cryptographically closed.**
  `passed` requires a per-run nonce the hidden test prints; a patch that knew the
  magic string and read `GYM_HIDDEN_NONCE` could forge it. The defense is that
  the agent never sees the scorer or the hidden test, so it cannot know the
  protocol; a guessed marker is `errored` (`test/gym-vacuity.test.ts`). Closing
  it fully would need the assertions to run outside the agent's process.

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

- **Lane starvation bound is not implemented.** The spec reserves lower bands a
  fixed fraction of every window; the scheduler gives lower bands nothing while
  a higher band is backlogged. Closing: reserve a share per window, choose and
  record the number, and test it under sustained high-band load.
- **OpenRouter limits/prices are asserted, not measured.** The quota spec states
  "20 requests/minute and 50/day" and per-million prices as facts with no
  artifact. Closing: a real-key run that records the observed headers and cost,
  or removal of the numbers.
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
