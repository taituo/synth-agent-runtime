# Known open items

Deliberately unfinished work, recorded so it is not silently dropped. Each item
says what is open, why it is still open, and what closing it needs. Items are
removed only when the closing work lands.

## Egress and artifacts


## Scoring-worker isolation

The gym scores an agent patch by running the patched module in a host worker
(`isolatedScoreGymPatch`, `src/gym/scoring.ts`). The worker is confined by Node's
permission model plus an explicit `node:sqlite` deny. That is a **guardrail, not
a security boundary**; the adversarial sweep in `test/gym-forge-channels.test.ts`
pins every channel it covers and the review's channel inventory names the rest.
The boundary for a *scored production run* is the gVisor pod
(`test/gym-sandbox-boundary.test.ts`, live), not this host worker.

Closed and regression-tested (`gym-forge-channels.test.ts`, failing-first for the
env allowlist, the permission model and the symlink guard): parent env secrets,
absolute and `/proc` reads, `/etc/passwd`, the fixture tree, `require`/`import`
outside, the scorer source, leaf/chain/relative/intermediate symlinks to the
vectors, `process.binding`, `worker_threads`, `module.register`, `node:sqlite`,
`child_process` and every write.

**Open below is the part of the channel inventory the permission model does not
cover at all.** None of these currently yields ground truth (the held-out vectors
are neither in a SQLite file nor on any reachable service, checked), so none is a
scorer pass today; each is a host-integrity escape and a latent bypass the day
the vectors become reachable through it. Closing needs an OS boundary
(dedicated unprivileged user, mount namespace with only the clone, network
namespace or no host TCP/unix access, seccomp), not another JS-level block. The
host worker is only used when a deployment does not set
`SYNTH_REQUIRE_ISOLATION=1`; that flag is a refusal, not a fix.

- **Network egress / DNS / UDP / unix sockets — OPEN.** Node's permission model
  has no network permission (`node --help` lists no `--allow-net`), so
  `node:net`/`node:dgram`/`node:dns` reach the host unimpeded. Measured inside the
  real worker: TCP to `127.0.0.1:8787` **CONNECTED**, `1.1.1.1:443` **CONNECTED**,
  UDP `send` **SENT**, DNS `localhost` **RESOLVED**, and `net.Server.listen` on an
  outside unix socket **bound**. `unshare -n` is `Operation not permitted` here,
  so a network namespace is not available unprivileged. This is an exfiltration
  channel (it composes with the closed-but-not-inherited-secret concern) and a
  reach into Temporal/Postgres/gateway listeners. Closing: OS sandbox with a
  network namespace, or a seccomp policy denying socket/connect.
- **`node:test` `run({ files })` — OPEN.** It loads and executes a file outside
  the allow-listed root (the review measured an outside test file; a re-probe
  produced `events:24` with the outside test enqueued). The loaded code still runs
  under the permission model, so it cannot read the vectors directly, but it is a
  loader path the model does not gate. Closing: OS sandbox (as above).
- **`process.kill` against the verifier — OPEN.** `process.kill(ppid, 0)` succeeds
  (`killPid1` is `EPERM`, correctly). A worker can SIGKILL the verifier and abort
  scoring; that is a denial of service, never a pass. Closing: unprivileged
  uid/pid namespace for the worker.
- **Host metadata — OPEN.** `os.userInfo().username`, `os.hostname()`,
  `os.networkInterfaces()`, `os.loadavg()` and `os.homedir()` all describe the
  host. Fingerprinting only, no score effect. Closing: OS sandbox.
- **`realpathSync` on an outside path — ALLOWED (metadata only).** It returns the
  canonical path string; any subsequent read is denied. Recorded so it is not
  mistaken for a read leak.



- **The corpus is a smoke test, not a benchmark.** The four `cve-*` items were
  moved to `ambiguous` (a vulnerability report is both `news` and `incident`),
  so the scorable set is 8 items; all three measured models score 8/8 = 1.0
  (`CORPUS_BASELINE`). Eight items is too few to gate on meaningfully — 7/8 =
  0.875 already fails a 0.9 gate, so the gate detects regressions, not
  capability. Closing: a corpus on the order of 100+ items, balanced across
  classes, with labels agreed by more than one annotator and the ambiguous set
  reported separately.
  **Progress (2026-09-20):** `corpusCoverage()` reports the scorable count,
  class balance and `benchmarkReady` (false), and `annotationAgreement()` with
  `secondAnnotatorLabel()` runs an explicit ambiguity procedure: a deterministic
  second pass that must agree with the recorded label, with disagreements
  reported as needing a human tie-break and excluded from the gate. Tests pin
  both, including that the corpus must not claim to be benchmark-ready.
  **Still open, and blocked on resources rather than code:** the 100+ balanced
  set needs licensed real texts across all three classes (social posts cannot be
  legally scraped) and a *human* second annotator; a synthetic-only expansion
  would measure template-following and is the kind of tuning this entry exists
  to prevent, so it was not done.

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
