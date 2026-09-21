# Audit of the coordinating agent's specs, decisions and verification

Reviewer: adversarial audit, 2026-09-20. Repo `main` @ `7478db6`. No tracked file was changed;
all probes were run from `/tmp/opencode` against the built `dist/` or via `git cat-file`.

> **Live working tree caveat.** While this audit ran, the working tree changed under me: at
> ~05:31-05:33 `src/index.ts`, `src/inference/gateway/lane-scheduler.ts`, `tenant-policy.ts`,
> `server.ts` and `test/lane-scheduler.test.ts` gained uncommitted edits (a `PriorityLanePolicy`
> integration, plus an explicitly labelled "FAILING-FIRST MUTATION: pure FIFO" in `#takeNext`).
> That is concurrent coordinator work, not mine. **Every finding below is pinned to HEAD
> `7478db6`**, and my root-suite run predates those edits. Also note: because root `dist/` is
> tracked, running `npm test` (which the task asked me to do) rebuilds it, producing modified
> `dist/*` files as a side effect. I made no source edits and no commits.


Commands that were actually run (so every finding below has an executed artifact behind it):

- `npm test` at the repo root -> `134/134 pass, 0 fail, 0 skipped` (`/tmp/opencode/audit-root-test.log`)
- `npm test` in `integrations/temporal` -> `46/46 pass` (`/tmp/opencode/audit-temporal-test.log`)
- `node /tmp/opencode/abs-oracle-probe.mjs` (absolute-path oracle probe)
- `node /tmp/opencode/treesource-parity-probe.mjs` (source-backed symlink parity probe)
- `node -e ...` lane-scheduler deadline probe
- `env -u OPENROUTER_API_KEY npx tsx openrouter-429-driver.ts` -> `{"skipped":true,...}` `EXIT:2`
- `git -C /tmp/opencode/fixture-repos/commander.git cat-file blob ...:tests/fixtures/...`
- `git grep -nIE "(AKIA[0-9A-Z]{16}|-----BEGIN ... PRIVATE KEY...|sk-...|ghp_...)"`

I did **not** re-run the live-infra proofs (gVisor kill, Temporal restart, 16-worker Postgres,
real-model baselines). Those are marked explicitly where relevant.

---

## Severity 1 — the rung-parity "real filesystem oracle" is a self-authored mock

**Claim.** `spec-rung-parity.md:51` — "The real filesystem is the oracle: the synthetic rung is
a simulation OF it". `docs/RUNG-PARITY.md` — "`RealFsExecutor` (a real temp-directory
filesystem)". `CHANGELOG.md` — "a differential harness ... runs seeded effect sequences against
both the synthetic rung and a real-filesystem executor (the oracle)".

**What the spec actually required.** `spec-rung-parity.md:47-49`:

> The real rung needs the cluster and a git-capable image, exactly like `fault-rungs.ts`
> (`SYNTH_EXECUTOR_IMAGE` pinned by digest). Absent that, SKIP as a distinct outcome — exit
> code 2, never `ok:true`.

**Why it is wrong.** The "oracle" is a class the coordinator wrote in the same commit, in
`test/fixtures/rung-parity.ts:70-124`, and it is not the real rung or even a neutral node-fs
adapter. It **imports and calls the synthetic code's own policy helper**:

```
test/fixtures/rung-parity.ts:82
  if (escapesWorkspace(raw)) return { ok: false, error: workspaceError(WORKSPACE_PATH_ESCAPES, raw) };
  const rel = normalizeRelative(raw);
```

So wherever the synthetic policy says "reject", the "real filesystem" arm says reject too. The
`../` row of the divergence table is therefore self-fulfilling, not measured. This directly
violates the repo's own rule (`ROADMAP.md:12`): "Live proofs, not mocks, for anything touching
Temporal, the executor rungs, or inference."

**Executed evidence — the oracle demonstrably diverges from a real filesystem.**
`abs-oracle-probe.mjs` writes `path = "/tmp/opencode/shard-escape-probe.txt"` through the
"real filesystem" arm:

```
RealFsExecutor result: {"ok":true}
wrote inside root? true
wrote at absolute path? false
```

A genuine node-fs write of that absolute path writes at the absolute path. The oracle silently
rewrites it into the temp workspace and reports success, i.e. it behaves like the synthetic
rung, not like a real filesystem. Because `escapesWorkspace("/etc/passwd") === false` (probed:
`normalizeRelative("/etc/passwd") = "etc/passwd"`, `escapesWorkspace = false`), a real
`writeFile` of an absolute path can never be caught by this harness.

**Sub-finding 1a — the silent-rewrite class is not fully closed.** The rung-parity docs claim
the "silent rewrite" defect was fixed for `..`; absolute paths still get `ok:true` and land at
a different path than requested (probe above: `workspace.write /etc/passwd` -> `{ok:true}`,
file appears as `etc/passwd`). This is the same failure class the spec says is "the worst
failure class", still present, and structurally invisible to the harness because the harness's
real arm shares the rewriting helper.

**Sub-finding 1b — source-backed workspaces (i.e. real repos) are not differentially tested.**
`treesource-parity-probe.mjs` reads a symlink on a `TreeSource`-backed `MemoryWorkspace`:

```
synthetic (TreeSource symlink read): {"ok":true} (no output)
real (real fs symlink read):         {"ok":true,"output":{...}} hello
```

The synthetic rung answers a symlink read with `ok:true` and no output — indistinguishable from
"empty file", the exact ambiguity the spec set out to remove. The generated harness never uses
a `TreeSource`, so the fixture class the Track-1 tests are built on (real repos, which really do
contain symlinks) is outside the differential harness. `docs/RUNG-PARITY.md` only says "there is
no effect to create one"; it does not document that reading an existing source symlink diverges.

---

## Severity 1 — the egress symlink decision is unimplementable as specified and unsafe if built literally

**Claim.** `spec-artifact-egress.md:56-67` and `ROADMAP.md:72-75`: "Preserve symlinks; validate
the target ... one that escapes is rejected with the shared `WORKSPACE_PATH_ESCAPES` error,
exactly as a traversing write already is."

**Why it is wrong.** The only existing "traversing write" check is `escapesWorkspace`
(`src/execution/workspace-errors.ts:19`). It only inspects literal `..` segments and ignores a
leading `/`. Executed:

```
escapesWorkspace("/etc/passwd") = false
escapesWorkspace("../../etc/passwd") = true
```

So the prescribed mechanism **accepts a symlink whose target is `/etc/passwd`** — exactly the
escape vector the spec says must be rejected. To reject it you must resolve the target against
the link's parent and then check the resolved path, which `escapesWorkspace` does not do.

It also **over-rejects legitimate repo content**. The Track-1 pinned repo `commander` contains
real in-workspace relative links:

```
git cat-file blob ba6d13dd...:tests/fixtures/another-dir/pm  -> ../other-dir/pm
```

Relative to the link dir (`tests/fixtures/another-dir/`) that resolves inside the workspace, but
`escapesWorkspace("../other-dir/pm")` returns `true` (a leading `..` at depth 0). A literal
implementation of the stated policy would reject commander's own files — the "corrupts a real
repo" outcome the decision was chosen to avoid.

**Also unspecified:** there is no workspace effect that can create a symlink
(`spec-rung-parity.md:88-95` and `docs/RUNG-PARITY.md` both admit this), so "preserve symlinks on
the workspace return path" needs new API surface that the egress spec never mentions. Target
resolution through chains and dangling links is not addressed.

---

## Severity 2 — the fault matrix's "proven" provider rows are not measured, and the test cannot catch it

**Claim.** `test/fixtures/fault-matrix.ts` header: "This table IS the deliverable ... every row
is `status: "proven"`". The `synthetic`/`real` columns for the six provider faults both say
"retry ... park ... recover". `test-suite-results.md:298-300` (gap #9) admits the opposite:

> Provider faults are asserted as non-differentiating **by construction**, not by running both
> executor rungs under each provider fault; ... that claim is reasoned, not tested.

**Why it is verification theatre.** `test/fault-matrix.test.ts:37-54` only checks: row exists,
`status === "proven"`, `synthetic`/`real` non-empty, the `artifact` path exists on disk, and the
`evidence` string matches one of a few substrings. There is **no** comparison of a row's claimed
behaviour to any executed behaviour for provider/temporal rows. The evidence predicate is
especially weak:

```
assert.ok(row.evidence.includes("EXECUTED") || row.artifact.endsWith(".test.ts") || ...);
```

Every provider row points at `.test.ts`, so this passes no matter what `evidence` says.
Concretely, you can rewrite `provider-502.real` to `"the workflow explodes"` and the suite stays
green. This is the same "a test that cannot fail for a real reason" the follow-up was supposed to
remove (`bug-report-waiting-spin.md:71-73`). The cited `fault-scenarios` runs live in
`/tmp/opencode`, not in the repo, so even the cited artifacts are not resolvable by the test.

---

## Severity 2 — the real-429 proof was never run, and the driver would not assert the claim if it were

**Claim.** `spec-quota-aware-retry.md:71-84` (item 3): "prove it against REAL 429s ... assert:
the agents park, **the wait actually tracks the returned header** ... record the observed headers
verbatim". Commit `285dec8` "Add real OpenRouter 429 driver".

**Executed evidence it never ran.** There is no `OPENROUTER_API_KEY` in the environment and no
log anywhere under `/tmp/opencode` containing `observedHeadersVerbatim`/`observed429s`. Running
the driver exactly as written:

```
$ env -u OPENROUTER_API_KEY npx tsx openrouter-429-driver.ts
{"skipped":true,"reason":"OPENROUTER_API_KEY not set; real 429 proof requires it"}
EXIT:2
```

The skip itself is correctly implemented (exit 2, no `ok:true`) — good. But the deliverable
("the real headers you observed from OpenRouter", `spec-quota-aware-retry.md:97-98`) does not
exist.

**The driver also omits the discriminating assertion.** `openrouter-429-driver.ts:99-110`
computes `parsedLastHintMs` and then never uses it in `ok`:

```
const lastHint = ... parseRetryHintMs(...) ...
const ok = rateLimited.length > 0 && parked && state?.status === "idle" && ... score.orderOk ...
```

`parked` is merely "some poll saw `waiting`". Nothing checks that the park duration tracks the
header. So even a successful run would not prove the thing the spec singled out as the point of
the test. (The `flux` here: `parsedLastHintMs` is printed and ignored.)

---

## Severity 2 — lane-scheduler guarantees a deadline it does not enforce; no property test

**Claim.** `spec-priority-lanes.md:41-47`: "a request that cannot be served within its deadline is
rejected, not parked forever"; property test (line 163): "no admitted request violates its lane's
deadline".

**Why it is wrong.** Deadlines are only enforced by `expire()`
(`src/inference/gateway/lane-scheduler.ts:108-121`), which the caller must invoke separately.
`release()` (`:129-134`) hands out whatever `#takeNext()` returns with no deadline check.
Executed probe with one lane `maxWaitMs: 5000`, clock advanced 6000ms, `expire()` never called:

```
seed  {"outcome":"admit"}
queue {"outcome":"queue","retryAfterMs":0,"ticket":"t1"}
release after deadline returned: {"lane":"interactive","tenantId":"t","key":"waiting","at":0}
```

The one deadline test (`test/lane-scheduler.test.ts:111-124`) calls `expire()` in isolation, so it
**cannot fail** on a scheduler that happily admits an expired request through `release()`. There
is no property test over arrival streams at all, which is what the spec asked for. This is a
discriminating-quantity gap of exactly the kind the repo rules warn about.

**Related decision gap:** the spec explicitly requires a starvation bound
(`spec-priority-lanes.md:110-112`): "each lower band is reserved a fixed fraction of every window
(e.g. ≥ 20%)". The implementation gives lower bands *nothing* when a higher band is backlogged
(`#takeNext`, `:144-146`, "only the highest priority band is eligible this round"), and the test
"band priority beats weight" enshrines that. The listed failure mode "starvation: a low band
under sustained high-band load" is therefore unaddressed, and no doc records the chosen number.

---

## Severity 2 — internal contradictions between the coordinator's own documents

1. **"Never content through history" vs the inline mechanisms.**
   `spec-artifact-egress.md:13-15` is absolute: "Artifacts must NEVER flow through Temporal
   workflow history ... content travels out of band, the workflow carries only a reference."
   But mechanism 1 (`:25-28`) *keeps* the existing path that base64-encodes the changed overlay
   inline, and part two's own "patch ... is the same thing in email shape" (`:102`) is content,
   not a reference. The prohibition and the retained mechanisms cannot both hold; the spec never
   reconciles the absolute "never" with a bounded inline path.
   (The already-known `Artifact.data: unknown` contradiction is real and confirmed at
   `src/core/types.ts:48`, with `MemoryWorkspace.exportArtifact` inlining the diff at
   `src/workspace/memory-workspace.ts:199-210`.)

2. **Does the gym need a judge?** `ROADMAP.md:88` — "Ground truth is objective ... so NO judge is
   needed", reinforced by item 6. `spec-artifact-egress.md:79-81` — "This is the plumbing the
   gym's evaluation step will need (roadmap 6: many cheap models produce findings, a few
   expensive ones judge them)." The egress spec is justified by a judge the roadmap says the gym
   does not use.

3. **Is the symlink question open or decided?** `ROADMAP.md:55-65` (2b) frames symlinks as an
   open design question and says "Do not start before priority lanes". `ROADMAP.md:72-76` (2c)
   says "Decided, not open ... That decision supersedes the open question in 2b." The standing
   queue still carries the superseded open question unannotated.

4. **Root-path handling.** `spec-rung-parity.md:79-82` raised the root-path throw as a
   "third behaviour ... the broker's contract is a result, not a throw"; that was fixed. But no
   doc states the new invariant, and `MemoryWorkspace.write/delete` still throw for root
   (`memory-workspace.ts:92,103`) for any other caller.

---

## Severity 2 — the roadmap is stale and over-claims completed work

- `ROADMAP.md` "Next, in order" still lists rung parity (1) and priority lanes (2) as pending,
  and says priority lanes "Needs a written spec before any code", yet `61783d9`, `075e82b`,
  `a4c1513`, `7478db6` are on `main`. The standing work queue does not reflect the commits it is
  supposed to coordinate. (The spec exists at `05:19`, code starts `05:22`, so the "spec first"
  rule was met; the queue simply was not updated.)
- `ROADMAP.md:20-24` says "Test suite tracks 1-6 ... Done". But `test-suite-results.md:271-277`
  (gap #1) admits Track 1's K8s-side clone/sync **and the interrupted-sync case** — explicitly
  required by `spec-realistic-test-suite.md:70-73` — were never written. "Done" is too strong.
- `test-suite-results.md:8-11` says "Every new test had a failing-first check ... except where
  noted", but gap #9 is a whole class (provider faults) with no failing-first and no cross-rung
  run.
- Same document contradicts itself: gap #8 (`:293-297`) says the CVE label disagreement is
  "documented but unresolved" while follow-up 2 (`:50-57`) and the fixture
  (`test/fixtures/messy-corpus.ts:14-25`) say the items were relabelled and re-measured. The
  "not covered" list was not updated after the follow-up.

---

## Severity 3 — omissions a careful engineer would expect

- **No CI for the Temporal integration.** `.github/workflows/core.yml` runs only the root
  `npm test`; `grep -rn temporal .github` -> "NO temporal in CI". The package the repo itself
  calls "the highest bar" (`bug-report-park-semantics.md:40-42`) has 46 unit tests and every live
  proof runnable only by hand. The root suite also does not include them, so a Temporal
  regression merges green.
- **Blob store / artifact index have no security or lifecycle story.** `spec-artifact-egress.md`
  defines put/get/stat/index with no read authorization, no retention/GC, no write quota, and no
  statement of who may resolve a digest. A content-addressed store reachable by any agent is a
  read-anything primitive; the spec treats it as pure plumbing.
- **Git-as-transport contradicts the existing sandbox credential posture.** `workspace-sync.ts:10-14`
  documents "without giving repository credentials to the sandbox". Mechanism 2
  (`spec-artifact-egress.md:30-38`) requires the agent to *push from inside the sandbox*, which
  needs credentials inside the untrusted sandbox. The spec does not design scoped/one-shot
  credentials or a broker.
- **The symlink-flatten claim has no executed artifact.** The claim "measured 2026-09-20 against
  the live sandbox" appears in `ROADMAP.md:56-60` and the egress spec, but no probe/log for it
  exists in `/tmp/opencode` (only `t1-probe.ts`, which tests `NativeGitSource` in-process). The
  code supports it — `kubectl-backend.ts:173-175` reads with `base64` (dereferences) and
  `writeFile` writes regular bytes — so I believe the claim, but it is asserted, not recorded.
- **Public-repo hygiene is manual.** Root `dist/` is tracked (164 files) while new build outputs
  are untracked (`git status`), and there is no secret-scan script despite the standing rule.
  I found no high-risk secret pattern in tracked files, but nothing enforces that on the next
  push.
- **OpenRouter policy and price claims are unmeasured.** `spec-quota-aware-retry.md:71-88` states
  "20 requests/minute and 50/day" and exact per-million prices as facts. No artifact; no run.

---

## Severity 3 — smaller issues

- `spec-quota-aware-retry.md:28-31` says "Reuse that parsing logic rather than writing a third
  copy." `integrations/temporal/src/retry-hints.ts` is a third copy. Its comment claims the logic
  is "deliberately the same", but it is not identical to either existing parser and does not
  handle duration-style `*-ratelimit-reset` values (e.g. `"6m0s"`), which `Number()` silently
  drops. Fine as engineering, but it contradicts the instruction.
- `test-suite-results.md` Track 6 replay proof is a hand-built probe, not a recorded history of
  the real `durableAgentWorkflow` (admitted gap #6) — the spec's stronger requirement
  (`spec-realistic-test-suite.md:143-148`) is unmet.
- The corpus "accuracy" is partly definitional: four CVE labels were changed to agree with the
  model, then 12/12 was measured on the same model (`fixtures/corpora/messy-events.ts` notes;
  `fu2-measure.log`/`fu2-green.log`). The roadmap now calls the gate a regression detector, which
  is honest, but the original Track-2 language ("accuracy is secondary; the structural check is
  the real test") should have been what was reported at the time.

---

## Claims I checked and found CORRECT (so you know what was examined, not skipped)

- **Root suite** `npm test` -> 134/134, 0 fail, 0 skip. **Temporal unit** -> 46/46.
- **Waiting-spin fix** (`abf931a`): `fu1-before.log` = 49 calls/4s, `ok:false`; `fu1-after.log`
  = 4 calls/4s, gap bounded; the fuzz generator really does fuzz the returned state
  (`generateReturnStates`) and asserts a minimum defer gap. Discriminating. Correct.
- **Retry-hint durable path** (`5389dee`): the live proof measures the park *gap* (call 3 -> call
  4), not wall time; `quota1-before2.log` shows `parkGapMs:1071, honoursHint:false, ok:false`,
  `quota1-after.log` shows `parkGapMs:2092, minParkGapMs:1500, reason:"server-retry-hint"`. This
  is a real discriminating assertion, unlike the earlier `quota1-before.log` draft. Correct.
- **402 permanent** (`230dedf`): present in `PERMANENT_HTTP_STATUSES`; quota exhaustion
  (`rawHint > MAX_PARK_HINT_MS`) is surfaced with `QUOTA_EXHAUSTED:` and `reason:"quota-exhausted"`,
  and `quota2-green.log`/`quota2-ff.log` demonstrate the failing-first control. Correct.
- **`two-workers-race`** is a real artifact (`integrations/postgres/concurrency.ts`) and is wired
  into CI (`postgres-live.yml` runs `npm run concurrency`), so it is a proven row. Correct.
- **The known `Artifact` contradiction** is exactly as documented (`core/types.ts:48`
  `data: unknown`, `exportArtifact` inlines content). Correctly caught.
- **`src/world` per-record CAS** exists (`world/types.ts:82`), as the egress correction claims.
- **Corpus relabel/date**: baseline text now reads `2026-09-20` `12/12 = 1.0`, gate `0.9`, and
  the earlier bad date was fixed in `5800a26`; `fu2` logs back the measurement. Correct.
- **Symlink flattening by the sandbox sync path** is consistent with the code
  (`kubectl-backend.ts:173-175`, `workspace-sync.ts:79-102`). Correct (though unrecorded live).
- **No high-risk secrets in tracked files** (git grep for private keys, `AKIA`, `sk-`, `ghp_`,
  `xox` returned nothing). Correct as far as that pattern set goes.
- **`../` is clamped by `normalizeRelative`, not a live escape vector** — confirmed; the spec's
  self-correction is right. The remaining defect is the silent rewrite/absolute-path case, above.

## Claims I could not independently verify (skipped)

Live-infra results I did not re-execute: the gVisor `fault-rungs`/`mixed-chain` runs, the
Temporal restart/signal/replay live proofs, the 16-worker Postgres run, and the real-model corpus
baselines. I verified their artifacts exist and their unit companions pass, but I did not bring
up k3s/gVisor/Postgres or the real gateway to reproduce the numbers.

---

# Second review round (independent check of 592399f, 65d2336, b14ef7d, 0c8ed61, 3e94b17)

Scope: I reviewed the five commits above at HEAD `3e94b17`, re-ran the suites and wrote targeted
probes. Commands run this round:

- `node --test dist/test/{symlink-target,blob-store,rung-parity}.test.js` -> `16/16 pass`
- `npm test` (root) -> `146/146 pass, 0 skipped`
- `integrations/temporal/node_modules/.bin/tsx scripts/lane-gateway-live.ts` -> `ok:true`
- `tsx /tmp/opencode/lane-disconnected.mts` (same proof, scheduler removed) -> `interactiveOvertookBatch:false`, `deadlineRejected:false`
- `tsx /tmp/opencode/lane-composite.mts` (spec's `CompositeTenantPolicy` path)
- `tsx /tmp/opencode/lane-edge.mts`, `lane-unknown.mts` (scheduler/policy edges)
- `node /tmp/opencode/treesource-parity-probe2.mjs`, `symlink-chain-probe.mjs`, `symlink-intermediate.mjs`
- `grep` of compiled `dist/test/fixtures/real-fs-oracle.js` for runtime imports
- a regex probe replaying the oracle-independence guard on import variants

## Direct answers to the three questions

**1. Is the parity oracle really independent?** Mostly yes, with two caveats. The oracle file's
compiled output imports only `node:fs/promises` and `node:path`; the only `src` import is
`import type` and is erased (`grep` of `dist/test/fixtures/real-fs-oracle.js` shows no `src/`).
The type it borrows (`src/execution/types.ts`) is types-only, so nothing behavioural is dragged
in. The oracle does not import the harness. **But** the comparison layer (`categoryOf` /
`diffOutcomes` in `test/fixtures/rung-parity.ts`) is coupled to the implementation: it classifies
a divergence as the permitted "escape" solely when the synthetic error string contains
`WORKSPACE_PATH_ESCAPES` (`rung-parity.ts:144`), and it normalises both sides' errors into shared
categories it defines by hand. And the guard that "asserts independence"
(`test/rung-parity.test.ts:160-165`) is a line-by-line string filter that only inspects
`real-fs-oracle.ts`; replaying its exact regex shows it catches a single-line value import but
**misses** a multi-line import and `await import("...")`. So: the oracle is genuinely independent
today, the *verification that it stays so* is weak, and the escape exemption is defined by the
implementation.

**2. Does the live HTTP lane proof discriminate?** Yes. I ran the exact script: order was
`D(429), A, C, B` with `C@1291ms < B@1893ms`, `ok:true`. I then ran the same scenario with the
scheduler disconnected (no `tenantPolicy`): order `A,B,C,D`, `C@747 > B@717`,
`interactiveOvertookBatch:false`, `deadlineRejected:false`. A pure-FIFO scheduler would also fail
(B arrived before C). So the proof is doing real work. **However** it passes the policy directly
and never exercises the composition the spec mandates (next finding), so it does not prove the
integration the coordinator claims.

**3. Does the symlink policy handle a link whose target is itself a link out of the workspace?**
For a *terminal* chain, yes: `resolveSymlinkTarget("dir/link1","link2",readLink)` with
`link2 -> /etc/passwd` returns `reason:"escapes"`, and a relative two-hop escape
(`link2 -> ../../../outside`) is rejected too. For an *intermediate* symlinked directory, **no**:
with `readLink("d") = "../outside"` and target `d/secret.txt`, `resolveSymlinkTarget` returns
`{ok:true, resolved:"d/secret.txt"}` even though on a real filesystem that path escapes. The
function only consults `readLink` on the fully-resolved path, never on intermediate components.
Also, with no `readLink` supplied at all, a chain is not followed and the first target is accepted.
And nothing in `src`/`integrations` calls this function yet (`grep` finds only the barrel export),
so the policy is not applied on any real egress path.

## Findings, ranked

### S1 — `CompositeTenantPolicy` does not forward `release`, so the spec's lane integration leaks slots (bug in 592399f)

The spec (`spec-priority-lanes.md:131-133`) requires `PriorityLanePolicy` to compose with ACL and
rate-limit policies "via `CompositeTenantPolicy`". `server.ts:192` frees the lane slot with
`options.tenantPolicy?.release?.(...)`, but `CompositeTenantPolicy`
(`src/inference/gateway/tenant-policy.ts:128-133`) implements only `authorize` and has no
`release`. Executed probe (`lane-composite.mts`), capacity 1, backend free after A:

```
PriorityLanePolicy has release? function
CompositeTenantPolicy has release? undefined
A: {"status":200,"ms":510} scheduler.inFlight after A: 1 (should be 0 if release were forwarded)
B: {"status":429,"ms":808,"retryAfter":"1"} scheduler.inFlight: 1
```

B is rejected with a 429 while the backend is idle and `inFlight` is stuck at 1; every subsequent
request queues and times out. The live proof avoids this by passing `policy` directly
(`scripts/lane-gateway-live.ts:54`). There is also a second leak: `admittedPrincipal` is set only
after the whole composite returned (`server.ts:136-137`), so if a later policy (e.g. the
rate-limit policy the spec orders after the lane policy) throws, the lane slot is never released.
No unit test covers `PriorityLanePolicy` or the composite at all (`test/lane-scheduler.test.ts`
has 11 tests, all pure-scheduler), and the only proof is the un-CI'd live script.

### S2 — the symlink policy ignores intermediate symlinked directories and is not wired in

`src/workspace/symlink-target.ts:68-92` resolves one link's target lexically and then follows only
the chain of the *resolved leaf*. Probe (`symlink-intermediate.mjs`):

```
A terminal chain out:        {"ok":false,"reason":"escapes","linkPath":"link2","target":"/etc/passwd"}
B intermediate symlinked dir: {"ok":true,"resolved":"d/secret.txt"}   <-- escapes on a real fs
C direct symlinked dir:       {"ok":false,"reason":"escapes","linkPath":"d","target":"../outside"}
```

So the containment goal ("one that escapes is rejected") is not met when a path component is a
symlink to outside the workspace — a common shape (node_modules, monorepo links). There is no test
for this case; all chain tests use an invented `readLink` map, and the real commander fixture only
has in-workspace links. The function is also exported but unused (`grep` shows no caller), so the
symlink-preservation decision is still not implemented on the sandbox return path the egress spec
targets.

### S3 — a source-backed symlink read still diverges from the real filesystem; the new test pins the implementation, not parity

`0c8ed61` changed `MemoryWorkspace.read` to return `source.readFile(p)` for symlinks
(`src/workspace/memory-workspace.ts:53-58`). For `NativeGitSource` that is the link target's
*text* (a mode-120000 blob). The independent oracle uses `node:fs`, which follows the link and
returns the target's *content*. Probe (`treesource-parity-probe2.mjs`):

```
synthetic: {"ok":true,"output":{...}} => target.txt
oracle:    {"ok":true,"output":{...}} => hello
SAME?  NO — still divergent
```

The new test (`test/rung-parity.test.ts:133-158`) asserts only that the read is non-empty and
equals `source.readFile(link)` — i.e. it pins current synthetic behaviour and never touches the
oracle. And `generateWorkspaceSequence`/`compare()` use a plain `MemoryWorkspace` with no
`TreeSource`, so the differential harness cannot see this. `docs/RUNG-PARITY.md` lists no such
accepted difference; it still says only "no effect to create one".

### S4 — the escape exemption is the implementation's own string, and the independence guard is bypassable

Demonstrated above. `diffOutcomes` (`test/fixtures/rung-parity.ts:144`) grants a permanent
exemption to anything the synthetic rung labels `WORKSPACE_PATH_ESCAPES`, and the random test
drops all such diffs before asserting (`test/rung-parity.test.ts:50`). A synthetic rung that
wrongly rejected a legitimate in-workspace path would be classified "escape" and ignored by the
generated test (the targeted non-path cases would likely catch a blanket regression, so this is a
narrowing, not an open hole). Combined with the textual independence guard, the *verification* of
the oracle's independence is much weaker than the oracle itself.

### S5 — `docs/RUNG-PARITY.md` is stale after the refactor

- Line 14 still names `RealFsExecutor`, which was deleted.
- Lines 17-19 say both rungs "return the same shared error vocabulary ... which is what makes them
  comparable"; the oracle now returns raw errno and comparability comes from the harness's
  `categoryOf` mapping.
- Line 15 claims the harness diffs "the final listing"; neither `runSequence` nor `diffOutcomes`
  captures a final workspace listing. That check does not exist.
- Lines 74-77 still say "Do not use the synthetic rung to test ... symlink behaviour", which
  contradicts the new symlink-read test and the 0c8ed61 goal.
- The doc calls the raw-OS oracle's confinement "matches the sandbox rung". The sandbox does not
  execute `workspace.*` effects at all (`KubernetesExecutor.canExecute` is only `process.exec`;
  the broker runs workspace effects on `SyntheticExecutor`), and the sandbox path helpers
  (`safeWorkspacePath`, `normalizeRelative`) *clamp* absolute paths rather than reject them, so
  "matches" is loose.

### S6 — pure `LaneScheduler.release()` still admits expired requests (round-1 finding only masked)

Re-ran the round-1 probe at HEAD:

```
pure release after deadline: {"ticket":"t1","request":{"lane":"batch",...,"key":"waiting",...}}
```

The `PriorityLanePolicy` timer (`lane-scheduler.ts:237-245`) now cancels expired tickets, so the
wired path behaves, but the scheduler's own guarantee ("no admitted request violates its lane's
deadline") is still unenforced and still has no property test. Anyone using `release()` directly
gets the old behaviour.

### S7 — `PriorityLanePolicy` ignores the scheduler's unknown-lane fallback

`LaneSchedulerOptions.defaultLane` promises "Lane used when a request names an unknown lane", and
`admit` honours it (`lane-scheduler.ts:94`), but `authorize` computes the deadline from the raw
unknown lane id (`:236`), gets `undefined`, and fires a 1 ms timer that rejects with
`retryAfterMs: 0`. Probe (`lane-unknown.mts`):

```
unknown-lane authorize after 201 ms -> rejected: LANE_DEADLINE: retry after 0ms
```

So an unknown lane is queued by `admit` and immediately deadline-rejected by the policy instead of
using the default lane's `maxWaitMs`. Minor, but it is an inconsistent contract and it emits a
`Retry-After: 0`.

### S8 — blob store is sound as a library but unwired, and `stat` loses metadata

`FileSystemBlobStore` (`src/artifacts/blob-store.ts`) is correct on the tested points
(round-trip, dedup-to-one-object, `BLOB_CORRUPT` on read, invalid digest rejected); the four
`blob-store.test.ts` tests are discriminating. But it is not used anywhere outside its barrel
export — no receipt carries a digest, so the spec's "a digest in a receipt resolves to exactly the
bytes the sandbox produced" and the history-size assertion are not implemented. `stat` always
returns `mediaType: "application/octet-stream"` (`:85`), discarding the `put` mediaType, so
`BlobRef` metadata is not round-trip stable. The round-1 omissions (no access control, no
retention/GC, no integrity check in `stat`) stand.

## Explicitly checked and CORRECT this round

- Root suite `146/146`, 0 skipped; new tests included. No regressions.
- The oracle file genuinely imports no implementation value: compiled JS imports only node
  builtins; the `src` import is `import type` and erased.
- Live lane proof is discriminating (disconnected and FIFO variants both fail the overtake
  assertion), and `deadlineRejected` requires the policy timer.
- Terminal symlink chains **are** handled: absolute and relative two-hop escapes are rejected;
  cycles and depth limits are enforced; dangling links are kept.
- `escapesWorkspace` now rejects absolute and Windows-drive paths (`workspace-errors.ts:20-22`),
  closing the round-1 absolute-path silent rewrite for the synthetic rung; the targeted tests
  assert the raw OS writes at the absolute path while the synthetic rung does not.
- `blob-store.test.ts` genuinely tests dedup (exactly one file on disk) and corruption detection.

## Skipped / not independently verified this round

- I did not re-run the gVisor, Temporal, Postgres or real-model live proofs.
- I did not modify any tracked file; probes live in `/tmp/opencode`. Running `npm test` rebuilt the
  tracked root `dist/` (repo convention), as in round 1.

---

# Third review round (adversarial check of the gym scoring work and the post-round-2 egress commits)

Reviewer: adversarial audit, 2026-09-20. Repo `main`, pinned to HEAD **`112af89`** ("Record
requested vs served model per turn, never guess"). The two commits the task names are inside
this window: `4402de2` ("Score a gym patch on a fresh checkout against a held-out test") and
`eb39d4e` ("Harden gym tampering detection against patch path tricks"); `112af89` landed
mid-audit. I read `/tmp/opencode/ROADMAP.md`, `MAP.md`, every `spec-*.md`, `review-findings.md`
and `review-followups.md`, then checked claims by running them.

> **Live working tree caveat.** The tree changed under me. When I started, HEAD was `eb39d4e`;
> while I worked, HEAD advanced to `112af89` and three tracked files
> (`integrations/opencode-http-gateway/adapter.ts`, `src/inference/gateway/profile-router-backend.ts`,
> `src/inference/gateway/types.ts`) gained uncommitted edits (model-visibility gap 1, the
> `modelIds` filter removal + `provider`/`profile` on `GatewayModel`). That is concurrent
> coordinator work, not mine. **Every finding is pinned to the commit named in it.** I made no
> source edits and no commits. I deliberately did **not** run `npm test` (which rebuilds the
> tracked root `dist/`); the suites below were run directly against the existing compiled
> `dist/` and via `tsx`, and all mutation experiments were done on a copy under
> `/tmp/opencode/audit3/mut`.

## Scope note (the instruction vs. what was actually unreviewed)

"Since `4402de2`" literally covers `4402de2` and `eb39d4e` (+`112af89` by the time I looked).
My predecessor's round 2 is pinned at `3e94b17` (`review-findings.md:366`), so the whole egress
series `ae95e42`…`66a3b52` was **never reviewed by anyone**. I audited the full window
`3e94b17..HEAD`, with primary effort on the gym commits. Findings from the older egress commits
are marked as such.

Commands actually run (so every finding has an executed artifact behind it):

- `/tmp/opencode/node22/…/node --test dist/test/*.test.js` -> `178/178 pass, 0 skip` (root, node22)
- `node --test dist/test/*.test.js` (system node18) -> `178/178 pass` (so the suite is not node22-only)
- `tsx --test test/*.test.ts` in `integrations/temporal` -> `49/49 pass` at `112af89`
- `node /tmp/opencode/audit3/gym-tamper-probe.mjs` (path-trick tampering bypasses)
- `node /tmp/opencode/audit3/tamper-bypass2.mjs` (`a/./` normalisation)
- `node /tmp/opencode/audit3/gym-cheat-probe.mjs` (**held-out-test score cheats**)
- `node /tmp/opencode/audit3/gym-vacuous-probe.mjs` (**skip/empty hidden test -> passed**)
- `node /tmp/opencode/audit3/gym-dos-probe.mjs` (scorer crash on a guessed hidden path)
- mutation runs against a copy: neutralize `isTampering`; delete `env.NODE_TEST_CONTEXT`
- `node symlink-intermediate.mjs`, `symlink-chain-probe.mjs`, `treesource-parity-probe2.mjs`
- `tsx /tmp/opencode/lane-composite.mts`, `lane-unknown.mts`
- `git apply --numstat -z` in a non-repo dir; `git grep` for artifact writers

## Severity 1 — the gym scorer's "passed" means "node exited 0", so the cheating agent it was built to stop scores green with a two-line edit

**Claim.** `src/gym/scoring.ts:1-8` and `4402de2`'s message: cheating is "the primary adversary",
the held-out test "decides the score", and the commit strips `NODE_TEST_CONTEXT` because that was
"the false-pass this piece was built to kill". `spec-gym-milestone.md:14-33,26-40` makes the
held-out test the decider and demands the diff be scored, not the sandbox.

**Why it fails.** The score is decided solely by the child's exit code
(`scoring.ts:182-187`: `if (run.code === 0) return { outcome: "passed" }`). The hidden test is
executed *in the same Node process as code the agent controls* — it imports `./lib.mjs`, the
very file the task asks the agent to change. So agent code runs before the hidden assertions.
Executed (`gym-cheat-probe.mjs`, real `scoreGymPatch`, fresh clone, unmodified scoring):

```
{"name":"process.exit(0) at import","outcome":"passed","out":  "…ok 1 - hidden.test.mjs…"}
{"name":"monkeypatch assert.equal","outcome":"passed","out":  "…ok 1 - hidden…"}
```

`lib.mjs` containing `process.exit(0);` at top level, or
`import assert from "node:assert/strict"; assert.equal = () => {};`, makes the scorer return
**`passed`** with the planted bug still present. `assert.ok` patching failed only because this
particular hidden test happens to use `assert.equal`; the class is open. A cheating agent does
not even need to be sophisticated: `process.exit(0)` also makes the *visible* test the agent is
told to green exit 0, so its own feedback loop rewards the cheat. The strongest adversary the
tests exercise is a constant-returning stub (`test/gym-scoring.test.ts:91-103`), which is
strictly weaker than what any model optimizing "make the test pass" will try.

**Why the suite cannot catch it.** No test puts a self-terminating or assert-mutating body in
`lib.mjs`; the suite's anti-cheat cases are all *patch-shape* cases (deleting/renaming/unicode
paths). The control that should make this fail — a patch that exits 0 without fixing the bug —
was never written. `context-checkpoint.md:15-16` lists three recorded failing-first mutations
(isTampering, timeout, visible-instead-of-hidden) and none is this one.

**Also: a skip or an empty hidden test scores `passed`** (`gym-vacuous-probe.mjs`):

```
{"name":"empty file","outcome":"passed"}
{"name":"all skipped","outcome":"passed"}
{"name":"no tests, just code","outcome":"passed"}
```

The scorer never asserts the hidden test actually ran (it discards the TAP `# pass N` count it
already has in `hiddenOutput`). `ROADMAP.md:14` states the working rule plainly: "A skip is never
`ok:true`. Distinct outcome, exit code 2." The gym scorer has five outcomes and no skip outcome,
and it maps a skipped run to `passed`. This is the *same* class as the `NODE_TEST_CONTEXT`
false-pass the commit set out to kill, one layer down.

**Fix direction (not implemented):** the hidden test must not run in the agent's process — run it
against the restored/checked-out tree with the agent's source quarantined from the test's import
graph, or assert the TAP result (expected test count, `# fail 0`, `# pass N>0`) instead of exit 0,
or both. And add the failing-first control: a patch that exits 0 without fixing the bug must
score `failed`/`tampered`, not `passed`.

## Severity 2 — `fcfa566`'s "artifact reference in effect results" is a bare type field; the "digest in a receipt" test is circular

Round 2 (S8) found the blob store sound as a library but unwired. `fcfa566` says it "add[s] an
artifact reference to effect results". Executed: `grep -rn '\.artifact =' src` returns **no
writer**; `EffectResult.artifact` (`src/execution/types.ts:39-41`) is declared and never
populated. The blob store is still used only by the live handoff script, never on a production
path, so no real receipt carries a digest.

The replacement evidence is also circular. `test/blob-store.test.ts` "a receipt digest resolves
to the bytes" does:

```
const receipt = { ok: true, artifact: ref };
assert.ok(Buffer.from(await store.get(receipt.artifact.digest)).equals(Buffer.from(bytes)));
```

The receipt is hand-built from the same `ref` and read back from the same store — it proves the
store round-trips (already covered) and says nothing about any receipt the runtime produces. This
is exactly the predecessor failure mode "its own probes are mis-wired and appear to confirm what
it expected": a green test named for a property it cannot observe.

## Severity 2 — the egress spec's mandatory blackboard correction is unimplemented, yet the roadmap marks 2c DONE

`spec-artifact-egress.md:130-158` is explicit: `Artifact.data: unknown` carries content inline and
must become a reference (`digest/size/mediaType/mechanism`), `producedFrom` added, the index
keyed by producer/input, "a breaking change to a published type: bump it properly, note it in
CHANGELOG, and check every existing writer and reader of `Artifact`". Executed: `src/core/types.ts:48`
is still `data: unknown`; `src/world` writers still store it as-is. `ROADMAP.md:136` nonetheless
reads "2c. Artifact egress [DONE — all four mechanisms, provenance with gap reporting, and handoff
by reference proven…]". The four mechanisms and the handoff are real; the correction that the
spec calls the actual work ("the work is to fix the existing blackboard, not to invent one") was
not done and is not in any "known open items" list.

## Severity 2 — workspace sync still flattens symlinks; the proof measures it but hides the result

`spec-artifact-egress.md:64-79` and `ROADMAP.md:183-213` require the sandbox workspace
return path to preserve mode 120000, and the spec adds "fix it anyway — the workspace path is
used by … `pi-synthetic-git-prototype`, and it should not lie there either." The git transport
(`ae95e42`) preserves symlinks, but nothing changed `WorkspaceSynchronizer` or
`KubectlSandboxBackend.writeFile`; the live proof itself records this and then drops it:
`integrations/kubernetes/git-transport-live.ts:98-102` computes `syncBackKind`, and the last
gVisor log (`/tmp/opencode/git-transport-live3.log`, `ok:true`) prints
`"workspaceSyncKindForSymlink": null` — i.e. sync-back has no symlink — and still reports
`ok:true` because `syncBackKind` is excluded from the `ok` expression. `ROADMAP.md:183` says
"symlinks are preserved"; that is true of the git path only, not the workspace path the sentence
is about.

## Severity 2 — round-1 findings that were silently dropped from the fix queue

`review-followups.md` enumerated only five items and `ROADMAP.md:37-41` calls that file "the top
of the queue". Two round-1 Severity-2 findings are not in it and remain unfixed:

1. **Fault-matrix provider rows are still unmeasured and the test still cannot catch it.**
   `test/fault-matrix.test.ts:53` still accepts `row.evidence.includes("EXECUTED") ||
   row.artifact.endsWith(".test.ts") || …`, and `test/fixtures/fault-matrix.ts` rows
   `provider-502`/`provider-429`/`PROVIDER_TIMEOUT` point at `.ts`/`.log` names, so the predicate
   passes regardless of what `evidence` says. Round 1 (its S2) showed you can rewrite a provider
   row to nonsense and stay green; that is still true. The `provider-429` row's evidence even
   cites a *unit* test of HTTP classification (`gateway-run-turn.test.ts`), not a live 429.
2. **The real-429 proof is still unrun and still non-discriminating.**
   `integrations/temporal/openrouter-429-driver.ts:99-110` computes `lastHint` and prints it
   (`:119`) but never includes it in `ok`; `ok` is still `rateLimited.length>0 && parked && …`.
   Round 1 showed this and it was not addressed; `spec-quota-aware-retry.md`'s "prove it against
   REAL 429s … assert the wait actually tracks the returned header" remains unproven.

These predate `4402de2`, but they are live "verification claims" and the coordinator's own
follow-up process is what dropped them.

## Severity 3 — the tampering hardening (`eb39d4e`) works for the tricks it names; its blind spot is the score, not the paths

To be fair to `eb39d4e`: I tried the bypasses it claims to close and it closes them.
`gym-tamper-probe.mjs` / `tamper-bypass2.mjs`, real `scoreGymPatch`:

```
plain                       -> tampered
no diff --git header        -> tampered   (tests 6)
rename away from test/      -> tampered   (tests 7)
quoted non-ASCII under test/ -> tampered  (tests 8)
a/./test/...                -> errored    (git apply rejects "invalid path")
```

and the mutation control confirms the tests bite (neutralize `isTampering` -> tests 4-8 fail;
delete `env.NODE_TEST_CONTEXT` -> tests 2,3,10 fail under node22). Two caveats:
- A hand-crafted patch that reaches a protected path via `./` is classified `errored`, not
  `tampered` (`tamper-bypass2.mjs`), so the spec's "record that as `tampered`" is not met for that
  shape (it is safe — it does not apply — just mislabelled).
- The `./`-variant *violates the working rule* (`ROADMAP.md:14`): a protected-path touch should
  never come back as a different outcome. Low impact.

The real problem is that `eb39d4e` spends its whole surface on the *reporting* label while the
score itself is trivially cheatable (Severity 1). Tampering was never load-bearing: the visible
test is not what scores. Hardening the label while leaving the score forgeable is the wrong
priority, and the commit message's "the false-pass this piece was built to kill" reads as if the
false-pass class were closed when a larger one remains.

## Severity 3 — a guessed hidden-test path crashes the scorer instead of yielding an outcome

`gym-dos-probe.mjs`: a patch that creates a directory at `hiddenTestDest` (default
`hidden.test.mjs`) makes `scoreGymPatch` reject with an uncaught error rather than return one of
the five outcomes:

```
{"outcome":null,"thrown":"Error: EISDIR: illegal operation on a directory, copyfile …"}
```

`spec-gym-milestone.md:39` requires every run to record `passed|failed|tampered|timed-out|errored`.
The destination is meant to be secret, so this is low, but the scorer's own defaults should not be
agent-reachable crash surface, and `copyFile` after apply has no error handling.

## Severity 3 — spec/model-visibility ordering and stale coordinator bookkeeping

- `spec-model-visibility.md` is stamped HIGH, "do this before the rest of the gym". It was written
  at 07:04; the next commit, `eb39d4e`, is gym work at 07:06:27 with no model-visibility
  implementation, and the only model-visibility commit (`112af89`, gap 2) is at 07:10 — *after*
  the gym hardening. Gap 1 (a standing "list what models exist") and gap 3 (compare a measurement
  across models) are not implemented; `112af89`'s record is genuinely discriminating (its two new
  tests fail on the old `body.model ?? options.model`, verified by mutation of the test bodies),
  so the partial item is good, but the "do first" ordering was not honoured.
- `ROADMAP.md:108-109` (Known open items) still lists "`CORPUS_BASELINE` records the measurement
  date as 2026-09-19 … Fix the date." It was fixed in `5800a26`; `test/fixtures/messy-corpus.ts:25`
  now reads `2026-09-20`. The known-open list claims open what is closed.
- `ROADMAP.md:37-41` says rung parity "is NOT trustworthy … See `/tmp/opencode/review-followups.md`,
  which is now the top of the queue." All five follow-ups are addressed (`65d2336` oracle
  independence + `e36102b` `escapesByPath` guard; `b14ef7d`/`85a3b39` symlink containment incl. the
  intermediate symlinked-directory case, re-run: case B now `escapes`; `0c8ed61`/`f56efc5`
  source-backed symlink read now byte-identical to the oracle, re-run: `SAME? yes`). The queue note
  is stale in the opposite direction.
- `CHANGELOG.md` contains **zero** occurrences of "gym" (`grep -c gym CHANGELOG.md` -> 0). The two
  gym commits are the newest work and the roadmap calls item 4 IN PROGRESS, so this is an omission
  rather than an over-claim — but `context-checkpoint.md:15-16` claims failing-first mutations were
  "recorded" and no such log exists in the repo or in `/tmp/opencode` (searching `gym` finds only
  the spec and the checkpoint). The repo rule says a failing-first check must be *recorded*.

## Claims I checked and found CORRECT this round

- Root suite `178/178`, 0 skip, under both node22 and node18; Temporal suite `49/49` at `112af89`.
- `NODE_TEST_CONTEXT` fix is real and, unlike my predecessor's framing, **is exercised**: removing
  `delete env.NODE_TEST_CONTEXT` makes tests 2, 3 and 10 fail under node22. Measured directly:
  `NODE_TEST_CONTEXT=1 node --test child.mjs` exits 0 on node22 vs 1 on node18 (the project
  requires node22), so the comment's mechanism is accurate.
- `eb39d4e` path-hardening behaviours listed above.
- `b0813db` fixed round-2 S1: re-ran `lane-composite.mts` — `CompositeTenantPolicy has release?
  function`, `inFlight after A: 0`, B `200` not `429`.
- `e24998d` fixed round-2 S6/S7: `lane-unknown.mts` now "still pending" at 200 ms instead of a
  `Retry-After: 0` rejection; the pure-`release()` deadline hole is closed at the committed path.
- `e36102b` fixed round-2 S4: `diffOutcomes` exempts by independent `escapesByPath`, and the
  oracle-independence guard now catches multi-line and dynamic imports.
- The four egress mechanisms exist and their unit tests are mostly discriminating: blob dedup
  (exactly one object on disk), corruption detection, git bundle tree-hash equality, inline
  ceiling throw. The handoff live proof's flat-history assertion is meaningful and the logs show
  it: `handoff-live2.log` `ok:false` (deltas 19/27), `handoff-live3.log` `ok:true` (deltas 12/23),
  so the CHANGELOG's "12–23 bytes" is measured; the roadmap's "17 bytes" is not either run's number
  (it is within the band, so tolerable, but it is not what the artifact says).

## Skipped / not independently verified this round

- Live infra I did not bring up: gVisor `fault-rungs`/`mixed-chain`, the Temporal restart/signal/
  replay and handoff live proofs, the 16-worker Postgres run, the real-model corpus/swarm
  baselines, and `npm run live:lane-gateway`. I read their artifacts (and the handoff logs show a
  first run that failed with an unrelated module-import error before the passing run), but did not
  reproduce them.
- `openrouter-429-driver.ts` was not run (no `OPENROUTER_API_KEY`); its skip path was already
  verified in round 1.
- I did not audit the uncommitted `112af89`-era model-visibility edits in the working tree; they
  are not committed work.
- I did not test the `git bundle` ingest path against a hostile bundle, nor the blob store's lack
  of access control/retention (round-1 omissions that still stand and are not implemented).

---

# Fifth review round — methodology of the gym fault matrix (gym-runner @ 2ae559f, read via `git show` from the main worktree)

Reviewer: adversarial audit, 2026-09-20. Read-only; no tracked file changed and the `gym-wt`
worktree was never opened. `gym-runner` is based on `112af89` and has moved **10 commits past
`143c7b2`**: the fault matrix is `4073822`…`2ae559f`, so question two/three/four below are
answered against the tip, with `143c7b2`'s own state called out where it differs. Evidence I
executed this round:

- `git show gym-runner:src/gym/{attempt,turn,tools,harvest,task}.ts`, `integrations/gym/{run-gym,p2-faults,sandbox}.ts`, `integrations/temporal/src/{gym-workflows,gym-activities,gym-contracts}.ts`, `docs/GYM-P2-RESULTS.md`, `CHANGELOG.md`
- `git log origin/main..gym-runner` / `git show --stat` on all ten commits
- reproduction of the golden patch on the real fixture: clone `he`@`36afe17`, apply `bug.patch`, commit, `git apply -R`, `git diff --cached` -> **358 bytes**, `sha256 d43f6c3f…` (`/tmp/opencode/audit5/golden.patch`)
- **the round-four scorer forgery probe**, re-run against main HEAD `2a4edda` (below)

## Carried over from round four: `f7d1241` is not unforgeable, and the real `he` task is forgeable

Round four was interrupted before it was written up, but the result matters for how every
"passed" in the matrix should be read, so it goes here.

`f7d1241` ("Make the gym score unforgeable by agent code") passes the run nonce to the child
with `env.GYM_HIDDEN_NONCE = nonce` (`src/gym/scoring.ts`), and the hidden test imports the
**agent-controlled** module. Agent code therefore reads the nonce out of its own environment.
Executed against the committed dist at `2a4edda`, on the real pinned `he/hex-decode` task
(`/tmp/opencode/audit4/gym-real-forge.mjs`), with the bug **not fixed**:

```
const __n = process.env.GYM_HIDDEN_NONCE;
if (__n) { console.log("GYM_HIDDEN_COMPLETE " + __n); process.exit(0); }
-> outcome: passed
   # GYM_HIDDEN_COMPLETE 3328f1ec-…
   # Subtest: hidden.test.mjs
   ok 1 - hidden.test.mjs
   # tests 1 / # pass 1 / # fail 0
```

No fake TAP is even needed: `node --test` counts a file that exits 0 before registering as a
passing subtest, so `tap.pass >= expectedHiddenTests` (1) is satisfied by the file itself, and
the completion marker is genuine because the code read the real nonce. The simpler lib fixture
scores `passed` the same way (`gym-forge2.mjs`). `test/gym-vacuity.test.ts` claims "the nonce is
held out, so a patch authored without seeing the scorer cannot know the magic string" and tests
only a *hardcoded guessed* marker (`"GYM_HIDDEN_COMPLETE forged"`) — it never tests
`process.env.GYM_HIDDEN_NONCE`, so the suite's probe is wired to confirm what it expects. The
`assert` freeze and the request/tool tampering work; the nonce is a mis-designed capability.
**Consequence:** `passed` is not a certification. The matrix passes themselves look legitimate
(traces show `read_file` → `replace_in_file` → `finish`, and no forgery), but the scorer cannot
distinguish a real pass from this, so no adversarial run can be believed.

## Q1 — are the arms genuinely identical except durability?

**The per-turn question is genuinely shared. The durable path is not resource-identical, and in
the end-to-end runner it sends a different request.** Verified:

- **One loop:** both call `runGymAttempt` (`src/gym/attempt.ts`); the plain arm in
  `runPlainOnce`/`runLivePlain`, the durable arm inside `runGymAttemptActivity`. One
  `maxTurns`, one `deadlineMs`, one classification path.
- **One prompt:** `runGymAttempt` builds `buildGymSystemPrompt(...)` + `buildGymUserPrompt(...)`
  itself; neither arm can substitute a prompt. The tool catalog is generated from the same
  `GYM_TOOL_DEFINITIONS`.
- **One tool surface:** `createGymTools(runner, …)` over the same `EffectRunner` interface.
  Critically, the **fault matrix uses `localEffectRunner` for both arms** (`p2-faults.ts`
  hardcodes `runner: "local"` for durable; plain builds a local runner), so rung is not a
  confound there — this is the right call.
- **One task:** both materialize the same fixture from the same cache; the durable activity
  materializes its own copy with a fresh random dir name (`materializeGymTask`, no `repoDirName`).

Divergences that are **not** durability, in increasing severity:

1. **`apiKey` is not propagated to the durable arm.** `GymAttemptActivityInput` has `apiKey?`
   and the activity reads `input.apiKey`, but `runDurableWorkflow`'s `input` object omits it
   while `runLivePlain` passes `SYNTH_GATEWAY_API_KEY`. If the gateway is authenticated, the
   plain arm sends `Authorization: Bearer …` and the durable arm sends none. Present at
   `143c7b2` too. The fault matrix is unaffected (no auth on the flaky proxy), but the
   end-to-end arms are not the same request.
2. **Different total budget.** The durable workflow retries the whole activity (Temporal
   `maximumAttempts: 3`) and then parks in a `while (true)` loop; each activity execution calls
   `runGymAttempt` fresh, so it gets a new `maxTurns` budget. The plain arm is one
   `runGymAttempt`. The durable arm can therefore consume many more model calls for the same
   task; the 502/429 rows show durable 8 calls vs plain 1.
3. **Transcript is not durable.** `transcript` is declared inside `runGymAttempt`; an activity
   retry starts a brand-new empty conversation and re-materializes the repo from the bugged
   commit. So the durable arm restarts the agent (conversation *and* workspace), it does not
   resume it. This is stated for the workspace in `GYM-P2-RESULTS.md`; the conversation reset is
   not mentioned and is just as real.

So: identical prompt/tools/task, yes; "nothing in the durable path changing what the model is
asked", no (missing auth, and a fresh conversation with a larger budget).

## Q2 — is the plain arm a fair control, or a straw man? (The one that flatters us)

**Straw man.** The plain arm is defined in code as a no-retry single shot:

- `src/gym/turn.ts`, on `createGatewayGymTurn`: "one direct OpenAI-compatible request, no
  Temporal, **no retries**." It throws on the first non-2xx.
- `runPlainOnce` calls `runGymAttempt` **once** and returns the `errored` record. There is no
  retry loop, no backoff, no `Retry-After` handling on the plain side.
- The durable side was *deliberately* given the recovery in `4073822`: the activity throws
  `ApplicationFailure` on a transient failure so Temporal retries and then the workflow parks
  (`gym-workflows.ts`). The CHANGELOG is honest about this — "the durable activity throws and
  Temporal retries then parks … while the plain arm does neither" — but `GYM-P2-RESULTS.md`
  nonetheless concludes "the arms differ only in durability."

The 502/429 rows are therefore measuring **"has any retry at all"**, not durability across
process death. A plain loop anyone would actually ship retries a 502 and honours `Retry-After`
on a 429 (that is standard HTTP client behaviour, and it needs no Temporal, no leases, no
receipts). The 28 ms / 31 ms is just the round-trip of the first failing response; it is not a
durability measurement. The rows that are genuinely about durability are the process faults
(worker-restart SIGTERM, SIGKILL): there the plain child vanishes and the durable workflow
survives, which is a real difference in kind. The provider-fault rows should either (a) give the
plain arm the same bounded transient-retry/backoff loop any reasonable implementation would have,
or (b) be reported as "retry policy" rows, not as evidence for durability. As written, the
headline "durable recovered, plain errored" is retry, relabelled.

## Q3 — is the byte-identical 358-byte patch genuine, or a cached/scripted artifact?

**Genuine model output, but almost information-free — it is the unique canonical diff, not
evidence of anything.** Executed: the checked-in `bug.patch` is 358 bytes; applying it to
`he`@`36afe17`, committing, then reversing it and running `git add -A; git diff --cached HEAD`
produces a **358-byte** golden patch (`/tmp/opencode/audit5/golden.patch`,
`sha256 d43f6c3f…`) — the same one-line swap of `parseInt(hexDigits, 10)` back to `…,16)`.
Git's unified diff of a given before/after state is deterministic, and this task has exactly one
minimal correct edit, so *any* run that makes the minimal fix must produce the same 358 bytes.
It is not sourced from `goldenReversePatch` or any cache: the live runs use
`createGatewayGymTurn` against a real model, the traces show `read_file`/`replace_in_file`/
`finish`, and the call counts are 4–8. But because the result is forced by git determinism, the
byte-identity should not be cited as corroboration that the arms agree; it only says every
passing run found the same one-line fix. (It is also the only signal that the model did *not*
rewrite the file wholesale — a successful `write_file` of the ~30 KB source would have produced a
large patch, per the doc's own truncation confound.)

## Q4 — my own view of why 5a produced zero bytes, before the commit's explanation

What I can establish from the code without the doc: on SIGKILL, Temporal re-runs
`runGymAttemptActivity`, which calls `materializeGymTask` again (fresh random `repoDir`, clone of
the pinned **bugged** commit) and starts `runGymAttempt` with a new empty `transcript` and a
fresh `maxTurns` budget. So the resumed run is a **new conversation about a wiped workspace**.
5a ran 8 calls (its full budget) and harvested 0 bytes, i.e. the resumed attempt never reached a
net edit before its turns ran out. Re-materialization is *why the earlier progress was lost*, but
it cannot by itself be the cause of 0 B, because 5b and 5c also re-materialized and passed. My
reading: 5a is a fresh attempt that failed to finish in budget (the model wandered, or its
`replace_in_file` edits did not land uniquely), with the restart guaranteeing no prior work could
save it. The doc's instrumented 5c (attempt=2, first `read_file` sees BUGGED) proves the
re-materialization mechanism, but no trace was captured for 5a, so "the model made no net edit"
is inference from the 5c mechanism plus the 0 B, not a measurement of 5a. The doc's own later
correction is the important part and I agree with it: what exists is **control-plane durability**
(the workflow/task survives the worker), not **work-product or conversation durability**. The
0 B sample is consistent with that, and the architectural finding is stronger than the anecdote
used to introduce it.

## Methodology issues that stand independent of the four questions

- **`143c7b2` is a 46-file / ~3,825-line drop** ("Add the gym end-to-end runner") and `4073822`
  adds another ~808. `ROADMAP.md`'s working rules say "Small pieces. One item at a time, fully
  green before the next. No large untested drops." The user's note that this landed in one commit
  is correct; the runner and its core (`attempt`/`turn`/`tools`/`task`/`harvest`) are one
  unreviewable unit.
- **`--dry-run` is a smoke test, not a control.** It uses `goldenFixTurn` (writes the golden patch
  directly; no model, no gateway) and `localEffectRunner` for both arms, and the "durable" dry arm
  is the driver's own `for` loop around `runGymAttempt`, **not** `gymAttemptWorkflow`. So
  `--dry-run` never touches Temporal, the activity, the park/backoff path, the sandbox runner, or
  model-reply parsing. It cannot see the exact failures that actually confounded the matrix
  (malformed/truncated replies, `max_tokens`, re-materialization). Passing it says the pipeline
  is wired, nothing about the durable path.
- **`GYM-P2-RESULTS.md`'s part ONE** claims the arms "differ only in durability" while part TWO's
  own method (durable retries/park, plain does not) contradicts it; the two claims should not be
  in the same document. This is the round-1 failure mode recurring at the methodology level:
  a strong claim in the summary that the body's own design does not support.
- The doc is otherwise unusually honest (it records `differentiated: false` rows, the malformed
  confound, harness deaths, and its own corrected hypothesis); the problem is the interpretation
  layer, not the raw logging.

## Checked and CORRECT this round

- The single shared loop, prompt builder and tool definitions really are shared (`attempt.ts`,
  `tools.ts`); the fault matrix really uses the same local rung for both arms.
- The durable workflow really does retry/park on transient failures (`gym-workflows.ts`), and the
  activity really throws for that to happen (`gym-activities.ts`).
- The hidden test on the real fixture fails on the bug and passes on the clean tree
  (`test/gym-real-task.test.ts` passes against the warmed cache; the cache is not skipped).
- The golden-reverse-patch is 358 bytes and equals the model's passing patch, confirming the
  minimal-fix reading.

## Skipped / not independently verified this round

- I did not re-run the live P2 matrix (needs the flaky proxy, Temporal :7233, the warmed `he`
  cache and real `kimi-k2.7-code` quota). Answers to Q2–Q4 rest on the committed
  `GYM-P2-RESULTS.md`, the committed code, and the golden-patch computation, not on a fresh live
  reproduction.
- I did not run `--dry-run` (the branch's `tsx` deps and dist are not in this worktree); the
  dry-run analysis is from `run-gym.ts` reading at the tip.
- I did not audit the non-gym commits on `gym-runner`, nor the standing uncommitted
  `rate-limit-scope.ts` edit in the main worktree.

---

# Sixth review round — audit of the response to the round-five forgery finding

Reviewer: adversarial audit, 2026-09-20. Read-only; the local worktree had been switched to
`signal-swarm` = `origin/gym-runner` `2fc3642` by the coordinator, so I read both sides with
`git show` as asked (never opened `gym-wt`). Full evidence commands:

- `git show 6793536:src/gym/scoring.ts`, `git show 2fc3642:src/gym/{isolated-score,attempt,checkpoint,task,tools}.ts`
- `node /tmp/opencode/audit6/attack-main-hmac.mjs` (signing-oracle vs the HMAC scorer)
- `node /tmp/opencode/audit6/attack-iso-readcases.mjs` and `attack-iso-real.mjs` (real `he/hex-decode`)
- `node /tmp/opencode/audit6/attack-scoped-push.mjs`, `attack-scoped-race.mjs`
- `node /tmp/opencode/audit6/attack-legacy-fallback.mjs`
- inspection of the real checkpoint store `/tmp/opencode/gym-checkpoints` (pointer + blob bytes)

**Headline.** Both redesigns fixed the *specific* round-five payload (the env nonce) and both are
still forgeable, each through the channel the redesign did not consider. `bf56bca` protected the
key but left the signing function callable by the agent; `f697904` protected the protocol but
left the ground-truth vectors readable by the agent's process. A pass is still obtainable with the
planted bug unfixed on both.

## ONE-a — main `bf56bca` (HMAC harness): forgeable via the harness as a signing oracle

The design deletes the key file before the agent module is imported, so the key itself is not
observable. But the `gym-hidden-harness.mjs` that holds the key is written **into the clone** and
exports `check()` and `complete()` — and the agent's module runs in the same process. Agent code
does not need the key; it needs the oracle. Executed against main's committed dist
(`attack-main-hmac.mjs`), hidden test using `check`/`complete`, `expectedHiddenTests: 3`, bug
**unfixed**:

```
signing-oracle via harness -> outcome: passed
guessed-MAC control        -> outcome: errored ("signed result did not authenticate: forged")
```

The payload: at import, enumerate the clone, `import("./gym-hidden-harness.mjs")`, call
`h.check("forged-"+i, () => {})` a few times, call `h.complete()` (which signs the forged
transcript with the **real** key and writes the result file), then `process.exit(0)` before the
hidden test's own checks run. The MAC authenticates because it was produced by the real harness.
`test/gym-vacuity.test.ts`'s new test ("the per-run key is not observable … a forged result cannot
authenticate") computes a candidate MAC from `/proc/self/environ` and fails — it attacks key
guessing, not the available signing oracle, so it is wired to confirm the design's assumption
rather than to break it. This is the same failure mode as rounds four and five, one level up:
the new defense closes the *key* channel and the test only probes that channel.

## ONE-b — gym-runner `f697904` (isolated verifier/worker): forgeable by reading the held-out vectors off disk

The verifier/worker split is a genuinely better shape: the expected values are in the parent, the
worker only evaluates and reports, and the child's exit code is not consulted. But the worker runs
**unsandboxed on the same host**, and the task's expected values ship as a file
(`test/fixtures/gym-tasks/<repo>/<slug>/hidden.cases.json`). The worker can locate the verifier's
cwd through `/proc/<ppid>/cwd` and read them. Executed on the **real** `he/hex-decode` task with
`isolatedScoreGymPatch`, replacing `he.js` with a function that reads `hidden.cases.json` and
returns the expected value for each named input, bug untouched (`attack-iso-real.mjs`):

```
task: he/hex-decode   bugFixed: false   outcome: passed
cases: hex ascii/hex euro/hex emoji/hex astral/decimal reference/named entity -> all ok
```

The same attack on a synthetic `addOne` task passes all cases while `addOne` is still wrong for
every other input (`attack-iso-readcases.mjs`). The commit's own docstring says "It never sees the
expected value" — true of the protocol, false of the filesystem. This is not a protocol forgery
like ONE-a; it is a ground-truth leak, and for a code-fix task it is equivalent to cheating: the
agent hardcodes the hidden answers instead of fixing the bug. The isolated scorer's FORGE 1–3
tests cover the env nonce, early exit and assert mutation, but not "read the cases file", so the
suite does not exercise it. Fix direction: do not leave the vectors on a filesystem the worker can
reach (load them into the parent and pass nothing, or place the worker in a mount namespace with
no access to the fixture tree, or at minimum stop leaking the parent cwd and scrub
`/proc/<ppid>`), and add a failing-first test that reads `hidden.cases.json` from inside the
worker.

## TWO — the checkpoint SIGKILL "4 of 4" is not a forge, but its headline over-reads

I inspected the real checkpoint store. Stored checkpoint `…mfsu` (turnIndex 3) is the 358-byte
canonical `he.js` fix with a real model transcript (`servedModel: kimi-k2.7-code`); `…xamo`
(turnIndex 4) is 0 bytes. The re-score table is therefore honest and discriminating, and I could
not construct an external replay: the stored patch is itself a `git diff` harvested from the
agent's workspace (`harvestPatch`), so it can only contain edits the agent actually made; on resume
it is `git apply`-ed into the fresh checkout and the scored patch is re-harvested from the
workspace, not taken from the blob; and the isolated scorer compares real function outputs. Resume
keys are per-run workflow ids (`gym-…-<Date.now base36>` in `run-gym.ts`, `gym-fault-<…>` in
`p2-faults.ts`), so one run cannot pick up another's pointer; I found no key collision or stale
pointer. The checkpoint also cannot smuggle a protected-path edit past the scorer, because the
final patch still goes through `isTampering`.

The real caveat is interpretive, not a forgery: because the checkpoint at turn 1–3 can already be
the finished fix, a resumed attempt that merely calls `finish` scores `passed`. So the 4/4 result
demonstrates **"the work product made before the kill is not lost and is re-applied"**, not "the
resumed agent re-derived the fix after recovery". The doc's `resumedFromTurn 1–2` columns are
consistent with that, but "resumed and passed" reads as the stronger claim. Store-side, the only
hardening gaps are that the pointer is keyed by id alone (not bound to task/base commit) and the
store lives at a predictable shared path `/tmp/opencode/gym-checkpoints` — neither is reachable by
the agent, so neither is a demonstrated attack.

## THREE — scoped one-shot push grant (`31e6a01`): no bypass found in the attempts asked for

I attacked all the shapes the task named and several more, against main's compiled module with
real git 2.43 (`attack-scoped-push.mjs`, `attack-scoped-race.mjs`):

| attempt | result |
|---|---|
| expired grant (`ttlMs: -1`) | rejected (`no valid grant`) |
| reuse a consumed grant (same ref, new commit) | rejected (`no valid grant`) |
| two refs in one push (A granted, A+B) | rejected (`exactly one ref update is allowed, got 2`) |
| `--no-verify` to a non-granted ref | rejected — the server hook still runs |
| `--no-verify` to the granted ref | allowed **and** consumed the grant (no bypass) |
| `git push --receive-pack='git-receive-pack --no-verify'` | git refuses the unknown server option |
| 10 concurrent pushes against one grant | 1 succeeded; the rest `no valid grant` or git `cannot lock ref … already exists` |

The one-shot check is a non-atomic read-then-unlink, so a race can let several `pre-receive`
hooks "authorize", but git's own ref lock fails all but one closed, so the grant still yields at
most one ref. Residual risks are the ones the new `docs/GIT-PUSH-CREDENTIALS.md` already states
(transport scope, untrusted content, exfiltration, read access); two implementation preconditions
are worth calling out because a misuse silently disables the control: `createScopedPushGrant`
writes `repoDir/hooks/pre-receive`, which only exists for a **bare** repo (a non-bare `repoDir`
would put the hook in the wrong place and authorize nothing), and the grant file lives in
`$GIT_DIR/synth-grants`, so anything that can write into the repo's git dir can mint a grant.
Neither is reachable from the sandbox push protocol.

## FOUR — the residual `GYM_HIDDEN_NONCE` premise is stale, and it is not the combinable capability

At `6793536` main's `src/gym/scoring.ts` does **not** set `GYM_HIDDEN_NONCE`; `bf56bca` removed
it. `git grep GYM_HIDDEN_NONCE 6793536` finds exactly one occurrence, in a test helper
(`test/gym-real-task.test.ts:95`), and the scorer sets only `GYM_HIDDEN_KEY_FILE` /
`GYM_HIDDEN_RESULT_FILE`. So the premise ("still puts GYM_HIDDEN_NONCE in the child environment")
was true one commit earlier (`112af89`/`2a4edda`) but is now false.

Substantively, the residual cannot be combined into a working forgery, for a boring reason: the
verdict no longer consults the nonce, so reviving it buys nothing on its own. The env pointer that
*is* still set (`GYM_HIDDEN_KEY_FILE`) leaks only the path of a file the harness unlinks before
agent code loads (`/proc/self/environ` keeps the path, not the key), and I could not reopen it
(no fd survives `readFileSync`, and the harness runs first). The capability that *does* turn a
residual into a working forgery is the signing oracle (ONE-a), which needs no residual nonce at
all.

There is a sharper residual on the other branch, though: `gym-runner`'s `src/gym/scoring.ts` is
the old exit-code scorer — `if (run.code === 0) return { outcome: "passed" }`, no nonce, no MAC —
and `runGymAttempt` falls back to it whenever a task ships no `hidden.cases.json`. Executed
(`attack-legacy-fallback.mjs`): a patch that prepends `process.exit(0)` to a buggy module scores
`passed`. `he/hex-decode` escapes only because it ships cases and `attempt.ts` prefers the
isolated scorer. The fallback should be deleted or made to refuse, not left as a silently
vulnerable default for the next task that forgets the cases file.

## Meta — both rescues guarded the wrong channel

Worth recording because it is the same pattern three rounds running. Round five's forgery read a
secret the design put in the agent's process. Main's fix assumed the *secret* was the whole
capability and did not remove its *use*; gym-runner's fix assumed the *protocol* was the whole
capability and did not remove the *ground truth*. In both cases the new test probes the exact
thing that was fixed (guessed MAC; env nonce; early exit) and passes, while the adjacent channel
is untouched. The durable rule from this: an "unforgeable" claim needs an adversarial test that
attacks every capability the agent's process actually has — imported modules, filesystem,
`/proc`, stdout/fd, and process control — not only the one channel the last finding named.

## Checked and CORRECT this round

- Main's `parseTap`/HMAC verification logic is correct on its own terms: a genuinely absent or
  wrong MAC is `errored`, a failing signed transcript is `failed`, an empty one is `skipped`; the
  harness really does delete the key file and the env pointer before the agent import; the
  `assert` freeze is present.
- Gym-runner's verifier/worker split is a real improvement: the child never receives expected
  values over the protocol, exit code is ignored, early exit is `errored`, zero cases is
  `errored`, and the golden/wrong/stub/assert-mutation controls behave.
- Gym-runner's checkpoint resume re-derives the scored patch from the workspace and is keyed per
  run (no cross-run replay); the committed re-score table is discriminating (the stored 0 B
  checkpoint fails).
- The scoped push grant rejects expired/consumed grants, multi-ref pushes and `--no-verify`, and
  survives a 10-way consume race.

## Skipped / not independently verified this round

- No live Temporal/gVisor/quota runs: the SIGKILL "4/4" question is answered from the committed
  results doc, the committed checkpoint blobs and the code, not by re-running the kill matrix.
- I did not run main's full suite (the worktree is on the gym-runner branch); I imported main's
  compiled `scoring.js` directly for the forgery probe.
- I did not test the isolated scorer against a worker that deliberately blocks/consumes fd 3 or
  `/proc` at the OS level beyond the cases-file read, and I did not attempt memory-level attacks
  (`/proc/<ppid>/mem`) on the verifier.
- I did not audit the non-gym commits on either branch (`31e6a01` is the only non-gym main commit
  I read in full).

---

# Seventh review round — independent verification of the gym-merge response (synth-verify, standing orders)

Reviewer: synth-verify, read-only, 2026-09-20. No tracked file changed, no commit. Self-directed
from CURRENT QUEUE items 1 and 2. **Refs:** I verified local `gym-runner` at `2301bf2` (the tip
with `f1218de` + `1d0fe68`); `origin/gym-runner` is still `2fc3642`, i.e. **the response is not
pushed** — a reviewer pinned to `origin` sees the old forgeable state. Local `main` is still
`6793536` at HEAD with the isolated-port work **uncommitted in the shared tree**
(`M src/gym/scoring.ts`, `D test/fixtures/gym-tasks/he/decimal-option/hidden.test.mjs`), so main's
scorer is unchanged. I did not read or touch those uncommitted edits.

Method: `git archive gym-runner` into `/tmp/opencode/verify-gym`, `rm -rf dist`, symlink
`node_modules` and `integrations/temporal/node_modules` from the main tree, `npm run build`,
`node --test dist/test/*.test.js` (node 22.20.0). Attacks run from `/tmp/opencode/audit6` against
the freshly built `dist/`.

## Verification #1 — full suite on the committed tip, clean build: PASS

`1..266 — pass 266, fail 0, skipped 0`. (The first run showed 4 skips because
`integrations/temporal/node_modules` was absent in my copy; after symlinking `tsx` they all ran.
The builder's `265/265` and my `266/266` differ by one test, benign.) This is the merge that was
`254/261`; it is green now.

## Verification #2 — the two round-six attacks

- **ONE-a (main `bf56bca`, signing oracle): STILL EXISTS.** Re-ran the round-six probe against
  main `6793536`: `signing-oracle via harness -> passed` with the bug unfixed; the guessed-MAC
  control still `errored`. Main has not had the isolated port committed, so queue item 1's main
  half is open.
- **ONE-b (gym-runner `f697904`, held-out-vectors leak): now blocked on the direct vectors.**
  `f1218de` spawns the worker under Node's permission model (`--permission
  --allow-fs-read=<work>`). Re-ran both round-six payloads on the real `he/hex-decode` task,
  bug untouched: read via `/proc/<ppid>/cwd` -> `errored` (6/6 cases fail); read via the absolute
  fixture path -> `errored`. A permission sweep returned by the module confirms
  `procCwd`, `absFixture`, `/proc/self/environ`, `child_process` and `process.binding("fs")` are
  all `ERR_ACCESS_DENIED`, while reading the clone's own `he.js` is allowed.

## Verification #3 — golden control (rule #2, order #2): PASS

The legitimate minimal fix (`parseInt(hexDigits, 10)` -> `16`) passes 6/6 cases under the
permissioned isolated scorer. So the sandbox does not simply reject everything.

## New finding — the permission sandbox is defeated by a symlink in the patch (latent reachability)

`--allow-fs-read=<work>` checks the literal path, and Node's permission model did not resolve the
symlink in my test: a patch that adds a symlink **inside the clone** whose target is the held-out
vectors file lets the worker read them through the allowed path.

```
symlink-to-file   (clone/escape.json -> <fixture>/hidden.cases.json)   outcome: passed  6/6
symlink-to-proc-cwd (-> /proc/<ppid>/cwd/.../hidden.cases.json)        outcome: errored (ENOENT)
```

`verify7-symlink.mjs`. So the commit's claim "Node's permission model confines filesystem reads
to the scoring work directory; the fixture tree and `/proc/<ppid>` are outside it and are denied"
is **false for a symlinked path** — the target is outside, the path string is inside.

**Reachability, stated honestly:** the gym's own agent tool surface
(`list_files`,`read_file`,`write_file`,`replace_in_file`,`run_visible_test`,`finish`) has no
symlink primitive and no arbitrary `exec`, and `write_file` writes regular files, so the model
cannot currently place a symlink into the patch it is scored on. The bypass is therefore a
*latent* hole in the `isolatedScoreGymPatch` library contract (any caller that scores a patch
containing a mode-120000 entry), not an active exploit of the gym as it stands today. It should
still be closed and pinned: resolve the realpath before the read decision, or (better) run the
worker in the same mount-isolated shape the sandbox rung uses, or do not leave the vectors on a
filesystem the worker can name. Per standing order 3 this attack is not yet a regression test
(the new FORGE 5/5b cover the direct `/proc` and absolute reads only).

## Verification #4 — checkpoint claim narrowing (`2301bf2`): PASS and well-tested

The results doc now states the narrower interpretation (pre-kill work is re-applied, not
re-derived). The new test `stronger claim: with a non-fixing checkpoint the resumed attempt must
make the edit` checkpoints a partial edit that provably does not contain the fix, asserts the fix
is absent before the resumed turn, and requires the resumed turn to produce it; the sibling
`control` sibling shows a different checkpoint key restarts from the bugged base and fails. These
would fail if resume replayed rather than re-derived, so the claim now has a discriminating test.
It is green in the 266.

## Queue status after this round

1. **Both scorers forgeable** — half closed. gym-runner's direct ground-truth leak is closed and
   the attacks have tests; a new symlink escape remains open and untested (latent reachability).
   main's signing-oracle is **untouched and still passing** on `6793536` (port uncommitted).
2. **Merge verification** — verified three ways on the local committed tip: suite 266/266 clean
   build, both round-six attacks now fail, golden control passes. The merge itself is unpushed
   (`origin/gym-runner` behind by the whole response), and the symlink caveat in #1 is the one
   open item before I would call the scorer attack-verified.
3. Next self-directed verification target (when I resume): the signal-swarm work (`c5d48db`,
   `src/swarm/*`) is on the local branch and was not in this round's queue scope.

## Artifacts behind this round

`/tmp/opencode/verify-gym-suite2.log` (266/266), `/tmp/opencode/audit6/verify7-iso.mjs`,
`/tmp/opencode/audit6/verify7-symlink.mjs`, `/tmp/opencode/audit6/attack-main-hmac.mjs`
(re-run). Committed-state build only; live Temporal/gVisor proofs not re-run.

---

# Seventh review round (formal) — the two scorer redesigns (origin/main 64cac44/885b4b9; origin/gym-runner f697904)

Reviewer: synth-verify, read-only. The entry directly above was an interim self-directed
verification; this is the round the task asked for. **Refs audited:** `origin/main` `6793536..
885b4b9` (only `64cac44` and `885b4b9`, both scorer) and `origin/gym-runner` `2ae559f..2fc3642`
(code commit `f697904`; the rest are results docs). Note `origin/gym-runner` is still `2fc3642`:
the sandbox fix `f1218de` and the claim-narrowing `2301bf2` exist only on the unpushed local
branch, so the gym-runner half of the response is not on origin. Read via `git show`/`git archive`
from this directory; no tracked file changed, no commit.

Method: `git archive` each ref into `/tmp/opencode/verify-main7` and
`/tmp/opencode/verify-gym-origin`, `rm -rf dist`, symlink deps, `npm run build`, then attacks
against the freshly built `dist/`.

## Environment verification

- **main `885b4b9`, clean build: `221/221` pass, 0 fail, 0 skipped** (`verify-main7-suite.log`).
- `git show origin/main:src/gym/scoring.ts`: the isolated verifier (worker child + fd 3 +
  permission model) has replaced the in-process scorer entirely; `isolated-score.ts` does not
  exist on main (merged into `scoring.ts`); `scoreGymPatch` now delegates to
  `isolatedScoreGymPatch` and requires `cases`.

## Finding 1 (high; latent reachability) — the permission-model sandbox is defeated by a symlink in the patch, on BOTH redesigns

The design claim in `64cac44` / `f1218de` is that the worker "runs under Node's permission model
confined to the scoring work dir, so the held-out vectors cannot be read off disk or via
`/proc/<ppid>/cwd`". The permission check is on the **literal path string**, and it does not
resolve a symlink for the final component. A patch that adds a symlink *inside the clone* to the
held-out vectors therefore reads them through an allowed path. Executed on the real
`he/decimal-option` task, bug untouched:

```
main 885b4b9 isolated scorer:
  GOLDEN control (reverse of bug.patch)     -> passed   4/4
  read via /proc/<ppid>/cwd                 -> errored  0/4
  read via absolute fixture path            -> errored  0/4
  read via symlink in the patch             -> passed   4/4   <-- BUG UNFIXED
```

(`/tmp/opencode/audit6/attack-main7.mjs`.) The same vector passes 6/6 on the local gym-runner
build at `2301bf2` (`/tmp/opencode/audit6/verify7-symlink.mjs`). The failing cases in an earlier
run of my own probe (`got "&#x20AC;"`) were the buggy module, because I diffed the symlink without
the cheat module; with both in the patch the cheat wins 4/4.

**Other vectors are closed** (main, sweep returned by the module): `/proc/<ppid>/{cwd,mem,environ,
cmdline}`, `/proc/self/environ`, `child_process`, `process.binding("fs")` and `worker_threads` all
`ERR_ACCESS_DENIED`; reading the clone's own file is allowed. A symlink used as an *intermediate
directory* was also denied (`symlink-to-directory then read truth.json` -> `errored`), so the hole
is specifically the leaf symlink whose target is the vectors file.

**Reachability, stated honestly:** the gym's agent tool surface
(`list_files/read_file/write_file/replace_in_file/run_visible_test/finish`) has no symlink
primitive and `write_file` writes regular files, so the model cannot currently put a mode-120000
entry into the patch it is scored on; the gym flow is not actively exploitable by this vector. It
**is** a real defect in the public `scoreGymPatch`/`isolatedScoreGymPatch` contract (any caller
that scores a patch containing a symlink) and it falsifies the stated confinement property. Per
standing order 3 it needs a permanent regression test, and a fix: resolve the realpath before the
read decision (with a depth/cycle limit), or run the worker in the mount-isolated shape the
sandbox rung already uses rather than relying on `--allow-fs-read`.

## Finding 2 (high; currently reachable on origin/gym-runner) — the origin/gym-runner scorer is the pre-sandbox one and the round-six leak still passes

`origin/gym-runner` `2fc3642` ships `f697904` with no permission model. Re-ran the round-six ONE-b
payload against the real `he/hex-decode` task: worker reads `hidden.cases.json` via
`/proc/<ppid>/cwd`, `bugFixed: false`, **`outcome: passed`, 6/6 cases**
(`/tmp/opencode/audit6/attack-iso-origin.mjs`). The fix `f1218de` is only on the unpushed local
branch, so the claim "both leak attacks failing" is true only for the local tree; on origin, this
scorer is still forgeable and the round-six finding stands.

## Checked and CORRECT

- main's suite clean-build green `221/221`, 0 skipped; golden control `passed` 4/4 (rule #2 — the
  sandbox does not reject everything).
- FORGE 4 signing oracle: main `errored` (`64cac44` removed the in-clone signer; there is no
  harness to import and `complete()` to call). The round-six ONE-a attack is closed on main.
- `885b4b9`: a legacy-shaped call (`hiddenTestPath`/`expectedHiddenTests`, no `cases`) returns
  `errored` with a clear detail, not a `TypeError` — verified.
- Direct vector reads (`/proc`, absolute) and the other sandbox vectors above are denied.
- `1aa0060` checkpoint resume still re-derives the scored patch from the workspace (unchanged on
  origin); the origin results-doc commits are consistent with the artifacts.

## Queue status after this round

1. **Both scorers forgeable** — main half now closed at origin (in-process signer removed,
   FORGE 4 errors); gym-runner half **not closed at origin** (pre-sandbox scorer still passes the
   direct read; the fix is unpushed). New open item on both: the leaf-symlink sandbox escape
   (Finding 1), latent for the gym tool surface, real for the library contract.
2. **Merge verification** — main has ported the isolated shape and is green; the local gym-runner
   tree is green (previous entry). The symlink hole is the one open blocker before I would call
   the scorer attack-verified on either.

Artifacts: `/tmp/opencode/verify-main7-suite.log`, `/tmp/opencode/audit6/attack-main7.mjs`,
`attack-main7b.mjs`, `attack-iso-origin.mjs`. Committed-state builds only; no live Temporal/gVisor
re-run.

---

# Seventh review round — addendum: re-audit at origin/main 885b4b9 (signing-oracle battery) and gym-runner 95dfab7 (does not compile)

Reviewer: synth-verify, read-only. Correction to the record: my earlier entry's verification #2
ran the signing-oracle probe against main `6793536` (pre-fix); `64cac44`/`885b4b9` landed after.
This addendum re-runs at the current tip. `git fetch origin` run; **`origin/main` is `885b4b9`
with 0 unpushed commits**; `origin/gym-runner` is still `2fc3642` (the `95dfab7` the task names is
the unpushed local `gym-runner` merge). Read via `git archive`/`git show`; no tracked file changed.

Method: `git archive 885b4b9` into `/tmp/opencode/verify-main7b`, `rm -rf dist`, build with node
22.20.0, then a battery of payloads against the freshly built `dist/src/gym/scoring.js`. Each
payload returns a diagnostic string so I can tell "blocked" from "never ran".

## The signing oracle at 885b4b9: closed. Battery, with the payload proven to run

| payload | outcome | evidence it ran |
|---|---|---|
| GOLDEN control (reverse of `bug.patch`) | **passed 4/4** | — |
| enumerate clone for a harness, import, `check`/`complete`, exit | failed | diagnostic lists the whole clone, `no harness: …he.js,package.json,src,tests` |
| import `./gym-hidden-harness.mjs` directly | failed | `ERR_MODULE_NOT_FOUND` |
| read `GYM_HIDDEN_RESULT_FILE` / `_KEY_FILE` / `_NONCE` | failed | all `"undefined"` |
| `process.getBuiltinModule("node:fs").readFileSync(vectors)` | errored | `ERR_ACCESS_DENIED` |
| read stdin fd for the request channel | failed | `EAGAIN` (and requests carry no expected values) |
| **read the vectors via a leaf symlink in the patch** | **passed 4/4, bug unfixed** | first case ok |

(`/tmp/opencode/audit6/oracle-battery-885.mjs`.) The signing-oracle class is genuinely gone:
there is no in-clone signer to import, the old env/result-file handles are absent, and
`getBuiltinModule` does not slip past the permission model. The earlier "errored" was not a
shallow pass — five variants were run and each was shown to execute. **One oracle-class attack
survives: the leaf-symlink read of the held-out vectors scores `passed` with the bug unfixed**
(4/4), because `--allow-fs-read` checks the literal path and does not resolve the final symlink.
This is the same defect recorded in the formal round-seven entry, now re-confirmed at `885b4b9`
and not fixed by the new commit. Direct `/proc/<ppid>/*`, absolute reads, `child_process`,
`process.binding`, `worker_threads` and an intermediate-directory symlink all stay denied.

**Reachability (unchanged):** the gym agent tool surface has no symlink primitive, so the gym flow
cannot plant the mode-120000 entry today; the public `scoreGymPatch`/`isolatedScoreGymPatch`
contract can. Fix: realpath-resolve the read (depth/cycle-limited) or mount-isolate the worker;
add the symlink payload as a permanent regression test.

## gym-runner 95dfab7: in-flight, does not compile

`git archive gym-runner | tar -x`, `rm -rf dist`, `npm run build` -> **exit 2**:

```
src/index.ts(20,1): TS2308  scoring.js already exported: GymCase, GymCaseResult,
                            IsolatedScore, IsolatedScoreOptions, isolatedScoreGymPatch,
                            isolatedScorerFor   (also in isolated-score.js)
test/gym-attempt.test.ts(91,115,127): TS2339  Property 'hiddenOutput' does not exist on GymScore
```

Exactly the merge collision the task described: main put the isolated verifier inside
`scoring.ts`, gym-runner kept `isolated-score.ts` and re-exports both. Not merge-ready; no point
attacking its scorer until the duplicate-export and stale-`hiddenOutput` breaks are resolved
(and then the origin/gym-runner `2fc3642` pre-sandbox leak, above, still applies to that module).

## Queue status after the addendum

1. main `885b4b9`: in-process signer removed and **signing-oracle battery closed**; direct
   ground-truth reads denied; remaining item is the leaf-symlink sandbox escape (latent for the
   gym tools, real for the library). Not yet fixed or tested.
2. gym-runner `95dfab7`: **does not compile** — in-flight. Origin/gym-runner `2fc3642` remains the
   forgeable pre-sandbox scorer.
3. Nothing here changes the earlier conclusion that the merge is not attack-verified: main is
   close (one sandbox hole), gym-runner is red.

Artifacts: `/tmp/opencode/verify-main7b` (built 885b4b9), `/tmp/opencode/audit6/oracle-battery-885.mjs`,
`/tmp/opencode/verify-gym-95` (failed build).

---

# Seventh round — channel inventory for the next symlink fix (the "what can the worker reach" list)

Status at time of writing: main is still `885b4b9` (no fix landed yet); `origin/gym-runner` is
`2fc3642`; local `gym-runner` `95dfab7` does not compile. Rather than wait, I enumerated every
channel the isolated worker can actually reach at `885b4b9`, so the next redesign can be swept
against the full list instead of one payload. Each probe returns a diagnostic and was run against
a clean `git archive` build of `885b4b9`.

## Reachable at 885b4b9 (the open surface)

| channel | status | detail |
|---|---|---|
| `fs` read through a **leaf symlink** in the patch | **OPEN** | `escape.json -> ABS_TRUTH` |
| symlink **chain** (`escape-chain -> escape.json -> truth`) | **OPEN** | depth not limited by the guard |
| **genuine relative climbing** target (`../../../../../../abs`) | **OPEN** | not only absolute targets |
| **all fs entry points** through the symlink | **OPEN** | `readFileSync`, `fs.promises.readFile`, `openSync`+`readSync`, `statSync`, `accessSync`, `realpathSync` (resolves to the outside path) |
| `fs.realpathSync` on an outside path | ALLOWED | returns the canonical path string (metadata only) |
| `data:` URL imports | allowed | no filesystem effect |

## Closed at 885b4b9 (probed, each attempted)

absolute path reads (`absRead`); `../` climbing (`dotdotRead`); `process.getBuiltinModule("node:fs")`;
`createRequire(import.meta.url)(abs)`; `statSync`/`opendirSync`/`readdirSync` of outside dirs;
`/dev/null`, `/dev/urandom`; `process.binding("fs"|"spawn_sync"|"tcp_wrap"|"pipe_wrap")`;
`child_process.execSync`/`spawnSync`; `fs` **writes** (`writeFileSync`, `openSync("w")`,
`symlinkSync`, `linkSync`, `process.report.writeReport`); `process.chdir(outside)` then a relative
read; `new Worker` (worker_threads) — `CREATE-DENIED`; `module.register` loader hook —
`REGISTER-DENIED`; `vm.SourceTextModule` — denied; `require`/`import` of a **symlinked JSON or
module** (`ERR_ACCESS_DENIED`); `fetch("file://…")` — failed. `/proc/<ppid>/{cwd,mem,environ,
cmdline}` and `/proc/self/environ` are denied (prior entry).

## What this means for the fix, and the next channels to attack

1. **The symlink primitive reaches the entire fs read surface, not one function.** A patch that
   only guards `readFileSync` leaves `fs.promises.readFile`, `openSync`+`readSync`, `statSync`,
   `accessSync` and `realpathSync`; a patch that guards the JS `fs` module leaves the module loader
   and any internal reader. The fix must resolve **every path component** (depth/cycle-limited)
   before allowing a read, or run the worker in the mount-isolated shape the sandbox rung uses.
2. **Keep the Node permission model.** `require`, `import`, `new Worker`, `module.register`,
   `child_process` and `fetch(file:)` are denied *today by the permission model*. If the fix
   replaces that with a JS-level preload/realpath check, those channels become the next holes —
   they were only ever closed by the model. Test after the fix: do they become reachable?
3. **Re-run the whole inventory, not the symlink payload.** Post-fix, the specific checks that
   should flip from OPEN to DENIED are the four rows above (leaf, chain, relative, entry points);
   everything else should stay DENIED, and a *new* OPEN anywhere is the next channel.
4. **TOCTOU / `realpath` races** need a write inside the clone; writes are denied to the worker,
   so a race would require a second actor. Worth one probe if the fix resolves via `realpath` and
   then reads the original path (classic check-then-use on a path the patch can pre-seed).
5. Still latent for the gym flow specifically (no symlink tool), real for the public scorer
   contract; the fix should add the symlink payload as a permanent regression test per order 3.

Reusable batteries saved: `/tmp/opencode/audit6/channel-sweep2-885.mjs` (sync + other-thread
enumeration), `next-channel-885.mjs` (module loading / require / import / fetch), and
`fs-entrypoints-885.mjs` (every fs entry point through the symlink). Point them at the rebuilt
`dist/src/gym/scoring.js` after the fix lands.

---

# Merged gym tree `cbcce0e` — independent attack of the combination, plus the realpath TOCTOU probe

Reviewer: synth-verify, read-only. This is my own run against the merged combination (both
branches together), which I had not attacked before. Built with `git archive cbcce0e` into
`/tmp/opencode/verify-merge`, `rm -rf dist`, node 22.20.0. No tracked file changed.

## Independent verification of the merge

| check | result |
|---|---|
| full suite, clean build | **271/271 pass, 0 fail, 0 skipped** |
| GOLDEN control (reverse of `bug.patch`) | **passed 4/4** |
| signing-oracle battery, 5 variants + diag each | all `failed`/`errored`; no harness in the clone |
| leaf symlink to the vectors | **tampered**, 0 cases |
| symlink chain / relative climbing / all fs entry points | **tampered** (guard catches before the worker) |
| `/proc` vector read (round-six ONE-b) | denied |
| module-loading channels (`require`/`import`/`fetch(file:)`) | tampered/denied |
| channel inventory (sync + other-thread) | every outside channel denied; only `realpath` metadata allowed |
| runner scorer selection | always `isolatedScoreGymPatch` with `cases`, no legacy fallback; tool surface unchanged (no symlink/exec primitive) |
| merge fixes | `36937b9` propagates `SYNTAX_GATEWAY_API_KEY` into the durable input (my round-six asymmetry fixed); `0f4a8be` drops the duplicate module — tree compiles |

So the builder's "271/271, battery blocked, golden passing" reproduces exactly under my own
build and probes. I found no bypass of the scorer in the merged tree.

## TOCTOU / pre-seed (the second task)

The guard (`findEscapingSymlink`) allows a symlink whose **realpath is inside the clone**, then the
worker reads later — a check-then-use. I probed whether a *static patch* can seed a path that
passes the check and reaches outside:

| pre-seed shape | result |
|---|---|
| `l -> .` (allowed), worker reads `l/../../../../<abs vectors>` | `errored` — `ERR_ACCESS_DENIED` (the permission model resolves the intermediate symlink + climb) |
| `l -> sub` (allowed dir) then climb | tampered (my `sub` was an untracked empty dir, so the link was broken; broken links are refused — correct) |
| `l -> /proc/self/cwd` then read through it | tampered (guard resolves in the parent, whose cwd is outside the clone) |
| `l -> /proc/self/root`, `l -> /proc/self/fd/3` | tampered |
| `l -> .` then read `l/.git/config` | allowed (inside clone), harmless — no vectors there |

**Conclusion: the patch cannot pre-seed a working check-then-use.** A pre-seed would have to make
the same link resolve *inside* in `findEscapingSymlink` and *outside* in the worker. The two runs
use identical kernel resolution from the same link directory, and the only process-dependent base
is `/proc/self/cwd`: the guard runs in the parent (cwd = repo/integration dir, outside the random
`/tmp/gym-isolated-*/clone`) while the worker runs with cwd = clone. To exploit that the patch
would have to know the random work-dir name at authoring time, which it cannot; every crafted
`/proc/self/cwd/<rel>` variant resolves outside in the parent and is refused. The guard→spawn
window is real but **needs a mutator**: the verifier only writes `worker.mjs` into `work` (not the
clone) between the check and the spawn, the worker has no write permission (writes/symlink/link/
open-for-write all `ERR_ACCESS_DENIED`), and no other actor shares the fresh clone. So TOCTOU is
theoretical for this threat model, not reachable by the patch.

## Latent gaps worth pinning (not exploitable today)

- **The guard skips any entry literally named `.git`, at any depth** (`if (entry.name === ".git")
  continue`), and `isTampering(["sub/.git"])` is `false` (the pattern requires `.git/`). A nested
  `.git` symlink to the vectors would skip both. Today `git apply` refuses `sub/.git` ("invalid
  path"), and `harvestPatch`'s `git add -A` silently ignores it, so it is not patch-reachable — but
  the skip should be tightened to the repo-root `.git`, and `.git` (no slash) added to
  `PROTECTED_PATTERNS`, so the guard does not depend on git's refusal.
- **`localEffectRunner.write` follows symlinks**: `resolveWithin` checks the lexical link path, then
  `fs.writeFile` follows the link, so with a base repo that contains a symlink, `write_file` on the
  link writes through to the target. `he` has 0 symlinks (checked), so the scored task is unaffected,
  and the scorer clone is separate; but `bae58c9` now preserves symlinks through the sandbox, so a
  future task on `commander` (which has symlinks) should get a test for this.

Verdict: the merged scorer is attack-verified against every channel I can reach; the two gaps above
are latent and should become regression tests. Artifacts: `/tmp/opencode/verify-merge-suite.log`,
`/tmp/opencode/audit6/merge-{oracle-battery,channel-sweep2,fs-entrypoints,next-channel}-885.mjs`,
`merge-toctou.mjs`.

---

# Next channel from the inventory: `node:sqlite` bypasses the Node permission model (read AND write outside the allow-listed root)

Reviewer: synth-verify, self-directed from the channel inventory. The inventory's "closed"
column covered the JS `fs` module, the module loader, `worker_threads`, `child_process`, addons,
`node:wasi`, the compile cache and the `/proc` paths. It had not tested **builtins that do their
own file I/O below the permission hook.** One does.

## Demonstrated

Against the merged build (`/tmp/opencode/verify-merge`), inside the scorer's own permissioned
worker (`--permission --allow-fs-read=<work>`, cwd = clone), agent code:

```
merge-nextch-class.mjs :  sqlite = READ:[{"module":"./he.js","ca…      (a DB outside the root)
                          fs (control, same path) = ERR_ACCESS_DENIED
                          dlopen = ERR_DLOPEN_DISABLED   (addons blocked)
                          wasi   = ERR_ACCESS_DENIED
                          signalParent = OK              (can signal the verifier)
merge-sqlite2.mjs      :  attachRead  = READ:SENTINEL-OUTSIDE-DATA-9c3f   (attached outside DB)
                          writeOutside = WROTE, createdByWorker: true     (created a DB outside)
                          fsWrite (same dir) = ERR_ACCESS_DENIED
merge-sqlite3.mjs      :  overwriteJson = ERR_SQLITE_ERROR   (non-DB file not clobbered)
merge-compilecache.mjs :  enableCompileCache = "write permission … not granted" (model respected)
```

So `node:sqlite` reads and writes **SQLite-format files anywhere on the host**, bypassing both
`--allow-fs-read` and the (implicitly denied) write scope, while plain `fs` on the same paths is
`ERR_ACCESS_DENIED`.

## Can it score `passed`? Not on the current task, and why

The verdict is the verifier's comparison in the parent process; to pass, the worker needs the
expected values. They live (a) in the parent's memory and (b) as `hidden.cases.json` — **JSON, not
SQLite**. `new DatabaseSync(ABS_TRUTH)` opens the file but any query is `ERR_SQLITE_ERROR`
(`jsonQuery`), and SQLite will not overwrite a non-DB file (`overwriteJson`), so the vectors
cannot be read or poisoned this way. I also checked the one SQLite file a gym host has, the
Temporal dev DB `/tmp/opencode/gym-temporal.sqlite`: `8364` and `hidden.cases` appear **0** times —
the activity output carries no expected vectors. So this is a **sandbox escape, not a scorer
bypass** today.

## Why it still matters, and the fix

- The commit's confinement claim ("the worker runs under Node's permission model confined to the
  scoring work dir") is **false for `node:sqlite`**, which reaches and mutates host SQLite state.
  Node's permission model is documented as a guardrail, not a security boundary against in-process
  code; this is that gap made concrete.
- It is a **latent scorer bypass**: any future change that persists expected values, case data or
  a secret in a SQLite file (or hands the worker one) makes `passed` forgeable again through this
  channel. The Temporal dev DB is a plausible such store.
- The write half is a **host-integrity escape**: the worker can create/alter SQLite DBs anywhere
  writable (e.g., the dev server's state), independent of the scorer verdict.
- Fix direction: do not rely on the permission model as the isolation boundary for agent code.
  Run the worker in an OS-level sandbox (mount namespace / container with only the clone
  bind-mounted, no host /tmp), or explicitly deny the `node:sqlite` builtin, and add a regression
  test that reads/writes an outside SQLite DB from inside the worker.
- Lower-severity channels from the same sweep worth noting: `process.kill(ppid, …)` is allowed
  (verifier DoS, no pass), and `node:net`/`node:inspector` are importable (no host service holds
  the vectors).

Artifacts: `/tmp/opencode/audit6/merge-nextch-class.mjs`, `merge-sqlite2.mjs`, `merge-sqlite3.mjs`,
`merge-compilecache.mjs`.

---

# Systematic enumeration of the permission model's actual coverage (builtins and capabilities reachable from the scoring worker)

Reviewer: synth-verify, self-directed. Method: instead of guessing payloads, run one battery
under the scorer's exact flags (`--permission --allow-fs-read=<allowed>`) and once without, and
diff. A capability is a bypass if it behaves the same both ways **and** reaches outside the
allowed root. Standalone harness `/tmp/opencode/audit6/perm-battery.mjs` plus self-contained
socket tests (`sock-self.mjs`, `final-enum.mjs`, `enumerate2.mjs`); outside sentinels in
`/tmp/opencode/enum-outside`. This is the "what can the process reach" list, not a per-payload
check.

## NOT covered by the permission model (reachable from agent code)

| capability | reach | evidence (under `--permission`) |
|---|---|---|
| `node:sqlite` | **read and write SQLite files anywhere** | read `SENTINEL-SQLITE` from an outside DB; created `sq-made.db` outside while `fs` write was denied |
| **Network — TCP** | connect to local services | `tcpTemporal7233 = connected`, `tcpPostgres5432 = connected`; `127.0.0.1:7233/5432` are Temporal and Postgres |
| **Network — unix sockets** (`node:net`/`node:http`/`node:https`/`node:http2`/`node:tls`) | bind (creates a socket file outside), connect, read/write | `listening` + `made.sock` created outside; `NET_CONNECT:SENTINEL-NET`, `HTTP_CONNECT:200:SENTINEL-HTTP` against an outside socket |
| `node:test` `run({ files })` | **loads/executes an arbitrary file outside** | `testRunOutside = events:15` on `/tmp/opencode/enum-outside/outside.test.mjs` |
| `process.kill` | signal any permitted pid | `signalParent = ok` (verifier DoS; no pass) |
| `os.userInfo`/`os.homedir` | host user metadata | `username: tiny` (minor) |

There is no `--allow-net` in Node's model: TCP and unix sockets are simply outside its scope.
Containerd sockets exist on this host (`/run/k3s/containerd/containerd.sock`, root-only, so
unreachable as `tiny`), and Temporal/Postgres are reachable on loopback — a host-integrity reach
independent of the verdict.

## Covered (denied under `--permission`, verified)

`node:fs`/`fs/promises` and `getBuiltinModule("node:fs")` reads and writes;
`node:child_process` and `node:cluster.fork()`; `node:worker_threads`; native addons
(`process.dlopen` -> `ERR_DLOPEN_DISABLED`); `node:wasi` construction -> `ERR_ACCESS_DENIED`;
`node:v8.writeHeapSnapshot` -> `ERR_ACCESS_DENIED`; `process.report.writeReport` -> denied;
`module.register` loader hooks; `module.enableCompileCache` (returns "write permission … not
granted", writes nothing); direct `/proc`, absolute and `..` paths.

## Why this matters, and the fix direction

- The permission model is a **guardrail for a few JS scopes, not a host-isolation boundary**: it
  covers fs, process creation, workers and addons, and stops there. Network (including
  filesystem-adjacent unix sockets), `node:sqlite`, `node:test` file loading and signals are all
  outside it. `node:sqlite` and the unix-socket reach are the same category as the SQLite finding:
  **host-integrity escapes independent of the verdict.**
- Every one is a **latent scorer bypass**: any of them becomes a direct pass the day the expected
  values are reachable through that channel (a DB, a local service, a readable module). The
  Temporal dev DB today holds no expected vectors (checked), but the Temporal/Postgres listeners
  are reachable and carry control-plane state.
- The fix is not another JS-level block: run the worker in an OS-level sandbox — dedicated
  unprivileged user, mount namespace with only the clone bound, **network namespace or no host
  socket/tcp access**, seccomp denying unix-socket creation/connect and the SQLite syscalls — and
  keep the permission model as defence in depth, not the boundary.
- Each demonstrated row becomes a permanent regression test: sqlite read/write outside, unix
  socket bind+connect outside, TCP reach to a local service, `node:test.run` of an outside file,
  and `process.kill`.

Artifacts: `/tmp/opencode/audit6/perm-battery.mjs`, `sock-self.mjs`, `final-enum.mjs`,
`enumerate2.mjs`, `merge-sqlite2.mjs`.

---

# Where the gym AGENT's code actually executes (the layer outside the scoring worker)

Reviewer: synth-verify. Determined by running the merged tree's real tool surface, not by reading.
The scoring worker's boundary was one layer in; this asks the same question about the agent that
runs model output.

Method: `createGymTools` over (a) `localEffectRunner` and (b) `buildSandboxRunner` (pinned gVisor
image, `synth-audit-gvisor`, cluster up). Probe `he.js` does its work at import time, then
`run_visible_test` (which `require`s `he.js`) executes it. Scripts:
`/tmp/opencode/audit6/agent-reach-local.mjs`, `/tmp/opencode/verify-merge/agent-{reach-sandbox,sandbox2}.ts`.

## Findings

**1. Tool handlers run in the harness's host Node process, for both runners.** `read_file` /
`write_file` / `replace_in_file` / `list_files` never enter the pod. Local runner: they touch the
host filesystem directly (`localEffectRunner`). Sandbox runner: they operate on a host-side
in-memory `MemoryWorkspace` via `SyntheticExecutor` — a `write_file("probe.txt")` came back from
`read_file` as the overlay, and the overlay *was* materialized into the pod before the next
`process.exec` (`cat probe.txt` in the pod printed `hello-from-agent`; the pod's `he.js` still had
the bug). So the agent's data edits reach gVisor, but the tool code itself runs on the host.

**2. `run_visible_test` is the code-execution channel, and it differs completely by runner.**

- **Local runner: model code executes on the HOST, unisolated.** `run_visible_test` runs
  `bash -lc "<process.execPath> --test test/visible.test.mjs"` in the repo dir. The visible test
  `require`s the agent's `he.js`, so the model's module code runs as uid `tiny` with no sandbox and
  no `--permission` at all. Probe output (`/tmp/opencode/agent-reach.json`):

  ```
  execUser: tiny
  hostRead: tiny                         (read /etc/hostname)
  hostWrite: WROTE                       (wrote /tmp/opencode/agent-reach-sentinel.txt)
  repoListing: [.git, .githooks, .github, …]   (listed the project tree)
  sqlite: SENTINEL-SQLITE                (read an outside SQLite DB — no --allow-fs-read applies)
  netAvailable: function
  hiddenCasesPath: …/test/fixtures/gym-tasks/he/decimal-option/hidden.cases.json
  hiddenCases: [ { "module": "./he.js", "call": "encode", "args": ["€"], "expect": "&#x20AC;" } …
  ```

  So **the agent's code can read the held-out vectors during the attempt** (and everything in the
  enumeration applies with no permission model in the way). Because the isolated scorer compares
  returned values, an implementation hardcoding those expected values passes.

- **Sandbox runner: the agent's code never runs, and the tool is broken.** `run_visible_test`
  sends `process.exec` to the pod, but the command is built with `process.execPath` — the *host*
  node path — and the alpine/git image has no node:

  ```
  run_visible_test: FAIL (exit 127)  sh: /tmp/opencode/node22/…/node: not found
  ```

  A direct pod exec also shows `git` failing with `fatal: detected dubious ownership in repository
  at '/workspace'` (no `safe.directory`), which would break `harvestPatch`'s `git add`/`git diff`.

**3. Tool surface vs process reach.** The surface exposes only `read_file`, `write_file`,
`replace_in_file`, `list_files`, `run_visible_test`, `finish` — no network, sqlite or symlink
tool. But `run_visible_test` executes model-authored code, so the *process reach* is whatever that
execution context grants: the full host under the local runner (all six classes, plus no
permission model), nothing under the sandbox runner because it fails to start.

## Consequence

- **The P2 fault matrix uses `runner: "local"` for both arms** (`p2-faults.ts`), and the dry-run
  uses local, so the headline results run model-authored code on the host with no isolation; the
  held-out vectors are readable from it. That is a complete grader bypass and a host escape in the
  same run.
- The ordinary `run-gym.ts` default (`sandbox`) does not expose that escape — but only because the
  agent's code never executes: `run_visible_test` exits 127 and pod git fails on ownership. That is
  a correctness failure, not a safe design.

## Recommendation

- Put the agent's execution inside the same OS-level boundary being built for the scoring worker
  (gVisor/equivalent), and make the held-out fixture tree unreadable from it. The permission model
  is nowhere in the agent path, so it cannot help here.
- Fix the sandbox path: pass a node that exists in the image (or install node), set
  `safe.directory`, and assert that the pod executes the agent's edited module.
- Regression tests: (a) agent code under the local runner must not reach host fs/network/sqlite
  and must not read `hidden.cases.json`; (b) sandbox `run_visible_test` must return the result of
  the agent's edit (exit 0, not 127); (c) the held-out vectors must not be readable from the
  agent's execution context in either runner.

Artifacts: `/tmp/opencode/audit6/agent-reach-local.mjs`, `/tmp/opencode/agent-reach.json`,
`/tmp/opencode/agent-reach-sentinel.txt`, `/tmp/opencode/verify-merge/agent-reach-sandbox.ts`,
`agent-sandbox2.ts`.

---

# Agent-path reach: local runner vs gVisor runner (what the agent's own code can reach)

Reviewer: synth-verify. Determined by running the merged gym's real tool surface
(`createGymTools` + `runGymAttempt`) over both runners. For the gVisor path I used a node-capable
image already cached on the cluster (`node:22-bookworm`) and `nodeBin: "node"`, which is what the
"working image" fix amounts to. Scripts: `/tmp/opencode/audit6/agent-reach-local2.mjs`,
`/tmp/opencode/verify-merge/agent-{gvisor-enum,gv-net,gv-cluster,gv-tools}.ts`. No tracked file
changed.

## The two reach lists

| probe | local runner (host) | gVisor runner (pod) |
|---|---|---|
| identity | uid **1000 (tiny)** | uid **65532**, `CapEff=0` |
| hostname | `tiny` (the host) | `synth-sandbox-small-…` (pod) |
| processes visible in `/proc` | **356** (all host pids) | **4** (own pid ns) |
| host repo `/home/tiny/.../synth-agent-runtime` | **visible** | **not present** |
| host `/tmp` | host `/tmp` | empty pod `/tmp` |
| held-out vectors `hidden.cases.json` | **found and readable** | not in the pod |
| host SQLite (`enum-outside/vectors.db`) | **read** (`SENTINEL-SQLITE`) | `node:sqlite` available but **pod-local only** |
| write host file | **`WROTE`** | not applicable (no host fs) |
| `execUser` / `child_process` | `tiny` | runs, but inside the pod |
| TCP to host Temporal `:7243` / Postgres `:5432` | **connect** | `ECONNREFUSED` |
| TCP to node IP `:8788/:5432/:6443` | connect | `ECONNREFUSED` |
| TCP to cluster API `10.43.0.1:443`, kube-dns `:9153` | n/a | `ECONNREFUSED` |
| TCP to kube-dns `:53` | n/a | **`CONNECTED`** |
| DNS resolution (external) | yes | **yes** (`resolveTxt example.com` returned records) |
| service-account token | n/a | **absent** |
| host-side tool handlers (`read_file`/`write_file`/`list_files`) | host fs (`resolveWithin` rejects abs/`..`, follows symlinks on write) | in-memory `MemoryWorkspace`; abs/`..`/host-repo paths → **`WORKSPACE_PATH_ESCAPES`**, no host write |
| `run_visible_test` (the code-exec channel) | `bash -lc "<host node> --test …"` → model code on the host | with `nodeBin:"node"` → **runs in the pod** (`exit 1` = the planted bug still fails, correct); with the pinned `alpine/git` image → **exit 127, `node: not found`** |

## What this means

- **The local runner has no boundary at all.** Agent code executing via `run_visible_test` runs on
  the host as `tiny`, sees every host process, the host repo, the held-out vectors, and host
  SQLite, writes host files, and reaches host TCP services. It is worse than the scoring worker
  under the permission model, because there is not even a permission model here. This is the path
  the P2 fault matrix used for both arms.
- **The gVisor runner is a real OS boundary for executed code** — separate pid/mount/net
  namespaces, uid 65532, no caps, no SA token, host fs/tmp/repo invisible, host and internet TCP
  refused. The Node-builtin classes (`node:sqlite`, unix sockets, `process.kill`, etc.) still
  exist *inside* the pod but are confined by the namespaces: no host state, no held-out vectors.
- **The gVisor network boundary is a per-pod `NetworkPolicy`, not gVisor itself.** In
  `synth-audit-gvisor` each sandbox pod gets a policy allowing **egress only to kube-dns :53
  (UDP/TCP) and to a `synth-egress-proxy` on :3128**, and ingress only from a `synth-control-plane`
  pod. That is why DNS works and everything else is refused. If the gym runs its sandbox runner in
  a namespace without that policy, the pod has open network. The egress proxy is not currently
  deployed, so **DNS is the one live egress channel** — an exfil path (DNS tunnelling) even with
  the rest closed.
- **The host-side tool handlers are a second trust zone.** In the gVisor runner, `read_file` /
  `write_file` / `list_files` run in the *host harness process* against an in-memory workspace;
  only `process.exec` goes to the pod. Today they are contained (absolute/`..`/host-repo reads
  return `WORKSPACE_PATH_ESCAPES`, no host file written), but the model's non-exec tool calls never
  enter the sandbox — so "one boundary" must cover the harness process too, not just the pod.
- **The sandbox agent path is only functional with a node-capable image.** With the pinned
  `alpine/git` image `run_visible_test` is dead (`exit 127`); with `nodeBin: "node"` and
  `node:22-bookworm` it runs the model's module in the pod. So the fix for the "sandbox agent
  path" is an image/node-bin change, not only isolation.

## One boundary or two?

**Two, and they are different in kind — but they can share the gVisor rung.** (SOLID from the above.)

1. **The local runner must be eliminated or wrapped.** The scoring-worker boundary does not touch
   it. If `local` remains an option for live model runs, the agent path is unbounded regardless of
   how good the scorer sandbox becomes.
2. **Agent and scorer have different requirements inside the same boundary:**
   - *Agent*: the repo must be materialized and writable, a node runtime must exist, and the
     network must be policy-limited (DNS-only today) with the egress proxy treated as an explicit,
     logged reach.
   - *Scorer*: no agent module in the verifier process, expected vectors never materialized into
     the sandbox, and the worker only reports raw values.
   Route both through the gVisor rung, but do not assume one policy fits: the agent needs the repo
   and a node image; the scorer needs the vectors absent.
3. **The Node permission model is not part of the gVisor path's defence and never was the agent's
   boundary.** It is a guardrail for the scorer's host-side worker; the agent's confinement in
   gVisor comes from namespaces + gVisor + the NetworkPolicy.

## Residual channels in the gVisor path (to pin, not to assume closed)

- **DNS egress** (kube-dns :53, recursing externally) — a covert exfil channel. If exfiltration
  matters, DNS must be restricted to an internal resolver or the sandbox denied external recursion.
- **The egress proxy on :3128** is allowed by policy; when deployed it is an intentional internet
  reach and should be logged/attributed.
- **`node:sqlite`, unix sockets, `process.kill` inside the pod** — confined today by namespaces;
  worth a regression test so a future policy/image change cannot silently widen them.

Artifacts: `/tmp/opencode/audit6/agent-reach-local2.mjs`,
`/tmp/opencode/local-agent-reach.json`, `/tmp/opencode/verify-merge/agent-gvisor-enum.ts`,
`agent-gv-net.ts`, `agent-gv-cluster.ts`, `agent-gv-tools.ts`.

---

# verify-1 — independent verification of `588bb34` ("Unify the turn body: the runTurn activity calls the shared GatewayAgentEngine")

**Verdict:** SOLID. The durable `runTurn` activity (`integrations/temporal/src/gateway-run-turn.ts`)
no longer builds a request or calls `/v1/chat/completions` itself; it maps the mailbox batch into
`GatewayAgentEngine.run` and maps the outcome back. Verified by an independent discriminating probe,
by the parent control, and by a full grep for surviving turn bodies. One **overstatement** is
recorded below (the durable activity supplies no `executeEffect`, so its tool calls are refused, not
executed through the rung).

**Environment wrinkle (record so the team stops tripping on it):** `/usr/bin/node` is **v18.19.1**;
this repo declares `"engines": { "node": ">=22" }`. Every command below ran with
`PATH=/tmp/opencode/node22/node-v22.20.0-linux-x64/bin:$PATH` (`node v22.20.0`). Running the
compiled suite under v18 produces false failures; use the node22 prefix.

## 1. Fresh committed worktree — build and suites

- `git worktree add --detach /tmp/opencode/orch/verify-588bb34 588bb34`; `rm -rf dist`; `npm install`
  (root and `integrations/temporal`); `npm run build` (both, exit 0).
- ROOT: `node --test dist/test/*.test.js` → **228 tests, 228 pass, 0 fail, 0 skipped** (log
  `/tmp/opencode/orch/verify-root-588bb34.log`).
- TEMPORAL: `npm test` (`tsx --test test/*.test.ts`) → **80 tests, 80 pass, 0 fail, 0 skipped**
  (log `/tmp/opencode/orch/verify-temporal-588bb34.log`).
- `dist/test/gateway-engine.test.js` (the engine's tool-rung test) explicit run → **1 pass**.
- Parent baseline for contrast: root **227** tests (commit adds exactly one: the gateway-engine rung
  test), temporal **78** (commit adds exactly two: the discriminating tests).

## 2. Failing-first control (parent red, child green)

The two named tests and the engine test are *added by this commit*, so checking out `588bb34^` does
not contain them. To run a real control I took the child's test file and put it on the parent's
source, isolating the changed implementation (the engine module `src/runtime/gateway-engine.ts` was
copied into the parent `src/` so the import resolves; the parent activity itself was untouched).

`git worktree add --detach /tmp/opencode/orch/verify-parent 588bb34^`, install/build (root + temporal
exit 0). Parent's own temporal suite: **78/78 pass**. Then copy in the child test file + engine
module and run:

```
cd /tmp/opencode/orch/verify-parent/integrations/temporal
npx tsx --test test/gateway-run-turn.test.ts
# tests 13  pass 11  fail 2
not ok 12 - runTurn invokes the shared engine body and makes no HTTP call of its own
        error: 'the activity must not make its own HTTP call'
not ok 13 - the durable activity and the in-process driver run the same engine body
        error: 'fetch failed'
```

The 11 pre-existing tests — the legitimate path — still pass on the parent; only the two
discriminating tests fail. The same file at `588bb34`: **13/13 pass** (tests 12 and 13 green).
`dist/test/gateway-engine.test.js` does not exist at `588bb34^` (`git ls-tree` shows neither
`src/runtime/gateway-engine.ts` nor `test/gateway-engine.test.ts`); it exists and passes at
`588bb34`. This is a genuine failing-first pair, not a test that passes on both.

## 3. Independent discriminating probe (my own, not the repo's test)

`/tmp/opencode/orch/probe-discriminate.mts` injects a fake engine that counts `run` calls and a
`fetchImpl` that counts and throws. Run against both trees (`TARGET=<worktree> tsx ...`):

```
PARENT 588bb34^ : {"engineCalls":0,"fetchCalls":1,"error":"activity must not make its own HTTP call"}  -> RED
CHILD  588bb34  : {"engineCalls":1,"fetchCalls":0,"classifications":[{"classification":"incident",...}]} -> GREEN
```

A second probe on the default (no injected engine) path (`/tmp/opencode/orch/probe-turn.mts`) shows
**gatewayCalls=1, globalFetchHits=0**, URL `http://gw.test/v1/chat/completions`, body carrying the
triage system prompt and the event text and **not** the planted `kind` — i.e. the one HTTP call is
built by the engine, and the activity adds none.

## 4. Call path (not existence)

- Activity reaches the engine: `integrations/temporal/src/gateway-run-turn.ts:200`
  `outcome = (await engine.run(messages, buildTurnContext(input, options.model)))`, where `engine`
  defaults at `gateway-run-turn.ts:184` to `createGatewayAgentEngine({... TRIAGE_SYSTEM_PROMPT ...})`.
- Tool call reaches the execution rung: `src/runtime/gateway-engine.ts:194`
  `const result = await context.executeEffect(effect);` — after the `toEffect` mapping at
  `gateway-engine.ts:187` and the guard at `:189`. The engine's only model HTTP call is
  `gateway-engine.ts:158` `await this.#doFetch(this.#url, ...)` with `#url` at `:142`.
- Grep of `integrations/temporal/src` for `fetch`/`chat/completions`: only the `fetchImpl` pass-through
  option — no second request builder.

## 5. A second turn body or a raw HTTP turn the claim misses

- `src/runtime/durable-turn.ts` (`DurableTurn`, `runDurableTransactionalTurn`) is a **transaction
  boundary** (buffers output/tool events, restores workspace on rollback, stages effects); it does
  not call the model or build an HTTP request. Not a turn body.
- `AgentRuntime` (`src/runtime/agent-runtime.ts`) is engine-agnostic: it calls `agent.engine.run`
  (`:324`) with the injected engine and wires `executeEffect` at `:333`. Expected to remain until
  runtime-2; not a regression.
- Remaining direct `/v1/chat/completions` callers are **live probes / fault harnesses, not turns**:
  `integrations/temporal/rate-limit-scope.ts:69`, `scripts/lane-gateway-live.ts:76`,
  `scripts/litellm-failover-live.ts:109`; plus server-side handlers
  (`src/inference/gateway/server.ts:120`, `integrations/opencode-http-gateway/adapter.ts:84`) and
  `integrations/temporal/flaky-gateway.ts:41` (fault injector). `src/adapters/pi/pi-engine.ts` is a
  different `AgentEngine` (Pi sessions), not a gateway turn body.
- Many temporal driver scripts define inline `async runTurn` stubs (e.g. `event-runner.ts:49`,
  `interceptors-live.ts:40`, `mailbox-property-driver.ts:53`) — workflow/determinism doubles with no
  model call. The real inference drivers (`corpus-inference-driver.ts`, `corpus-model-compare.ts`,
  `swarm-inference-driver.ts`, `openrouter-429-driver.ts`) all construct `createGatewayRunTurn`.

## 6. Where the claim overstates

The commit message / claim says the shared body executes "the model's tool calls through the
execution rung". That is true of the engine and is proven by `test/gateway-engine.test.ts`, and it is
wired in the in-process path (`agent-runtime.ts:333`). But the **durable** activity's
`buildTurnContext` (`gateway-run-turn.ts:154-166`) does **not** set `executeEffect`, and
`executeEffect` appears nowhere under `integrations/temporal/`. So on the durable path a model tool
call would hit `gateway-engine.ts:189` and be recorded as a refused observation
("No effect executor configured"), not executed. Harmless for the triage prompt (it yields no
`tool_calls`), but the claim as worded implies the durable path executes tools, which it does not.
Recommend narrowing the wording, or wiring an activity-side effect executor if durable tool
execution is intended.

## 7. Boundary probe (record only)

`/tmp/opencode/audit6/agent-reach-local2.mjs` still runs (needs the gym-branch build at
`/tmp/opencode/verify-merge`; it does not test this commit). Result unchanged from the prior round:
`{"uid":1000,"hostRepo":true,"hostWrite":"WROTE","sqlite":"SENTINEL-SQLITE","hiddenCases":
".../he/decimal-option/hidden.cases.json",...}` — the gym *local* effect runner still has full host
reach. Orthogonal to the turn-body unification; recorded, not a regression here.

**Repo untouched:** main checkout and `gym-wt` unchanged; all work was in `/tmp` worktrees and
probes. Artifacts: `/tmp/opencode/orch/verify-root-588bb34.log`,
`/tmp/opencode/orch/verify-temporal-588bb34.log`, `/tmp/opencode/orch/parent-transplanted.log`,
`/tmp/opencode/orch/parent-root.log`, `/tmp/opencode/orch/parent-root-2.log`,
`/tmp/opencode/orch/probe-turn.mts`, `/tmp/opencode/orch/probe-discriminate.mts`.

---

# verify-2 — independent verification of the gym boundary commits on `gym-runner` (HEAD `52586bd`)

Worktree: `git worktree add --detach /tmp/opencode/orch/verify-gym 52586bd`; `rm -rf dist`; root and
`integrations/temporal` `npm install` + `npm run build` (both exit 0). Node 22
(`/tmp/opencode/node22/.../bin`, `v22.20.0`) first on PATH. `gym-wt` and `main` untouched; the
worktree was removed at the end.

**Overall: claims 1, 2, 3, 5 SOLID; claim 4 LIKELY** — the substance holds (durable arm is a real
Temporal workflow + activity; control arm labelled) but the task's premise that it runs
`durableAgentWorkflow` is **false**: the gym durable arm starts `gymAttemptWorkflow`, a separate
registered workflow. Two overstatements and one defense-in-depth gap are recorded.

## Claim 5 first (the environment all the others are measured in)

- ROOT suite (`npm test` → `node --test dist/test/*.test.js`), Node 22:
  **295 tests, 294 pass, 0 fail, 1 skipped** (log `/tmp/opencode/orch/verify-gym-suite.log`).
- TEMPORAL suite (`integrations/temporal`, `tsx --test`): **78 tests, 78 pass, 0 fail, 0 skipped**.
- The single root skip is exactly the claim-3 boundary test:
  `ok 92 - the gVisor pod cannot see the host ... # SKIP set SYNTH_LIVE_GVISOR=1 and
  SYNTH_EXECUTOR_IMAGE to run the live sandbox boundary proof`.
- The "gym" tests specifically all pass: default runner, local refusal, hidden-vectors-not-planted,
  digest pin, durable-path pin (suite log lines 185/191/419/425/431/437/533/545/551).

## Claim 1 — `b984835` "sandbox is the only default; local is a labelled unisolated arm" — **SOLID**

Executed evidence, not prose:

- Compiled default: `parseGymRunner(undefined)` → `"sandbox"`; `describeGymRunner("local")` →
  `{"isolation":"unisolated","isolated":false,"scoredAllowed":false,...}`. Source:
  `src/gym/runner.ts:33` (`DEFAULT_GYM_RUNNER="sandbox"`), `:44` (`parseGymRunner`),
  `run-gym.ts:344`, `p2-faults.ts:129`.
- Default runner in `run-gym.ts` is `parseGymRunner(arg(args,"runner"))` (`run-gym.ts:344`) and in
  `p2-faults.ts` `parseGymRunner(...)` (`p2-faults.ts:129`) — both default `"sandbox"`.
- `run-gym.ts --dry-run` (the local arm) artifact:
  `"runner":"local","isolation":"unisolated","unisolated":true` — the label is in the JSON, not only
  in prose (`run-gym.ts:372-379`). `--dry-run --runner sandbox` still reports `runner:"local"` /
  `unisolated` (the dry arm always drives `localEffectRunner`, `run-gym.ts:149`) — honest.
- Scored local is refused, exit 2, with a labelled skip:
  `run-gym.ts --runner local` → `{"ok":false,"skipped":true,"unisolated":true,"reason":"refusing to
  score a run on the \"local\" runner: ..."}` exit **2** (`run-gym.ts:355`, `:396-400`).
- `p2-faults.ts --fault 502` (no `--runner`) → default sandbox, then hard error requiring
  `SYNTH_EXECUTOR_IMAGE` (`p2-faults.ts:376-383`); `p2-faults.ts --fault 502 --runner local` →
  `UnisolatedScoredRunError`, exit **1**. Both drivers build the same physical runner for both arms
  (`p2-faults.ts:167-180`, `run-gym.ts:203-213`; durable input carries `runner`/`image`,
  `run-gym.ts:300-306`, `p2-faults.ts:156-160`).

Can a scored run take the local host path by accident? Through the two drivers, no: `local` must be
requested explicitly and is then refused, and `buildSandboxRunner` throws on a missing image rather
than falling back (`sandbox.ts:119`). One **defense-in-depth gap**: the refusal lives in the drivers,
not in the activity/workflow. `gym-activities.ts:33` selects the runner with
`(input.runner ?? "sandbox") === "sandbox"`, so a direct `client.workflow.start("gymAttemptWorkflow",
{args:[{runner:"local"}]})` would run and score on the unisolated host with no refusal. Not the
default, but the boundary is not enforced where the code executes.

Overstatement: the sandbox default is new; the *recorded* fault matrix did not use it. Both
`sandbox.ts:7-9` and `gym-activities.ts:7-8` say every committed matrix row ran `runner=local` for
both arms. So "sandbox is the only default" is a code claim about future runs; no scored matrix
number yet rests on the isolated runner.

## Claim 2 — `3e9c060` "pin the repo executor image by digest for every default class" — **SOLID**

- Default classes (`src/execution/resource-class.ts:95-191`): exactly four —
  `sandbox-small`, `sandbox-medium`, `sandbox-heavy`, `project-cell`. Executed check against the
  compiled build: all four `pinned=true`, `same=true`, image =
  `ghcr.io/taituo/synth-executor@sha256:fc59cec2b7a3733e9e50db1d5063669c60ec7add0d18a338b2a3f19a422c822f`
  (`src/execution/executor-image.ts:23`).
- `ghcr.io/example/synth-executor:latest` is gone from all production code: `rg` finds it only in
  `test/executor-image.test.ts` comments/negative assertions. No `:latest` and no `image: "…"`
  literal remains in `src/` or `examples/` (`examples/kubernetes-demo.ts` now defaults to
  `EXECUTOR_IMAGE`).
- Digests are real, checked against the registries and the live cluster:
  - Dockerfile base `node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`
    equals the current Docker Hub manifest-index digest for that tag (media type
    `application/vnd.oci.image.index.v1+json`).
  - The example `node:22-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844`
    (`sandbox.ts:103`, `p2-faults.ts:380`, `sandbox-live.ts`) equals the Docker Hub
    `node:22-bookworm` index digest.
  - `ghcr.io/taituo/synth-executor@sha256:fc59…` is **not** on ghcr (anonymous token request is
    DENIED) but is a real local build: `k3s ctr -n k8s.io images ls` shows
    `sha256:fc59cec2…` = the same digest, and the live boundary test below pulled/ran it. So it is
    valid on this host/cluster; a *fresh* cluster cannot pull it from ghcr and would need the local
    import. That is consistent with the commit message ("built and imported locally for the live
    proof"), not a false pin.

## Claim 3 — `03cf1a8` "pin the sandbox boundary probes as a live regression test" — **SOLID (but gated; I ran it live)**

- In the default suite: the compiled test is at `dist/test/gym-sandbox-boundary.test.js` and is
  included by `npm test`, but `liveEnabled()` (`test/gym-sandbox-boundary.test.ts:30-32`) requires
  `SYNTH_LIVE_GVISOR=1 && SYNTH_EXECUTOR_IMAGE`; otherwise it **skips**. With no env (the CI default)
  the suite reports 1 skip — so as shipped to CI it is a regression test nobody runs. Say that
  plainly. It is not gated behind a separate `*.live.ts` filename that never compiles; it is a real
  compiled test, just env-gated.
- This host has the live cluster (namespace `synth-audit-gvisor`, the pinned executor image imported),
  so I ran it for real:
  `SYNTH_LIVE_GVISOR=1 SYNTH_EXECUTOR_IMAGE='ghcr.io/taituo/synth-executor@sha256:fc59…'
  SYNTH_KUBERNETES_NAMESPACE=synth-audit-gvisor node --test dist/test/gym-sandbox-boundary.test.js`
  → **1 test, 1 pass, 0 skip** (`/tmp/opencode/orch/verify-gym-boundary-live.log`).
- It asserts discriminating quantities, not a status (`test/gym-sandbox-boundary.test.ts:118-125`):
  `gvisor===true`, `hostRepo===false`, `hostTmpSentinel===false`, `hiddenCases===null`, and
  `hostTemporal/hostGateway/clusterApi/internet !== "CONNECTED"`.
- Control (same probe through the LOCAL runner, `/tmp/opencode/orch/gym-local-control.mjs`) reverses
  them: `{"gvisor":false,"hostRepo":true,"hostTmpSentinel":true,"hostTemporal":"DENIED:ECONNREFUSED",
  "hostGateway":"DENIED:ECONNREFUSED","clusterApi":"CONNECTED","internet":"CONNECTED"}`. So
  `gvisor/hostRepo/hostTmpSentinel/clusterApi/internet` genuinely discriminate; `hostTemporal` and
  `hostGateway` did not (nothing listening) and **`hiddenCases` did not**: the probe only walks
  `/workspace`, which is absent on the host, so both runs yield `null`. The "no vectors" assertion
  is weaker than it reads — it never proves the held-out vectors are unreachable outside
  `/workspace`. (Last round's host-reach probe found the vectors via the *host repo path*, which this
  test does not probe.)

## Claim 4 — `52586bd` "label the control arm and pin the durable (Temporal) call path" — **LIKELY**

- Overstatement / false premise: the durable arm does **not** go through `durableAgentWorkflow`.
  It starts `gymAttemptWorkflow` — a separate workflow defined in
  `integrations/temporal/src/gym-workflows.ts:47`, registered by
  `integrations/temporal/gym-worker.ts:14-18` via `workflowsPath: ./src/gym-workflows.ts`, running
  `runGymAttemptActivity` (`gym-activities.ts:18`). `rg durableAgentWorkflow` returns nothing under
  `integrations/gym` or `gym-workflows.ts`. The commit message itself says `gymAttemptWorkflow`; the
  task's wording is the error.
- Call path, with file:line:
  - durable: `run-gym.ts:310` `client.workflow.start("gymAttemptWorkflow", {...})` and
    `p2-faults.ts:262` the same; labelled `role:"temporal"` (`run-gym.ts:319`,
    `p2-faults.ts:285`, `:311`).
  - control: `runLivePlain` calls `runGymAttempt(...)` in-process (`run-gym.ts:227`) labelled
    `role:"control"` (`run-gym.ts:239`); `p2-faults.ts` plain paths labelled `role:"control"` at
    `:202` and `:348` (the killed child included).
- The pin is a **static source-text test** (`test/gym-durable-path.test.ts`), not a runtime call:
  regex over `run-gym.ts`/`p2-faults.ts`. Control run — I injected
  `await runGymAttempt({} as never)` into `runDurableWorkflow` in the /tmp worktree and re-ran the
  compiled test: `not ok 2 - the durable functions do not call runGymAttempt directly` (1 fail, 3
  pass); after `git checkout --` it is 4/4 pass. So it discriminates the exact regression it names.
- Minor inconsistency: `run-gym.ts` refuses local with exit **2** and a labelled skip
  (`:396-400`), while `p2-faults.ts` lets `UnisolatedScoredRunError` escape its generic catch
  (`p2-faults.ts:437-443`) → exit **1** with a stack. Neither is a false pass (0), but "a skip is
  exit 2" is only true for `run-gym.ts`.

## What is overclaimed / still open

1. Claim 4's `durableAgentWorkflow` wording is wrong; it is `gymAttemptWorkflow`. (Underlying
   substance — real Temporal workflow + activity, not an in-process call — holds.)
2. Claim 3's test ships skipped in CI; only a live-cluster run (which I did here) exercises it.
3. Claim 3's "no vectors" quantity is weak: it walks only `/workspace`, so it passes on a host run
   too. It does not test the host repo path where the vectors actually sit.
4. Claim 1: the local-run refusal is in the drivers, not in the activity/workflow; a direct
   `gymAttemptWorkflow` start with `runner:"local"` bypasses it. And the recorded matrix still rests
   on the unisolated local arm.

**Repo untouched:** `main` and `gym-wt` not modified; only the `/tmp` worktree (removed) and probes.
Artifacts: `/tmp/opencode/orch/verify-gym-suite.log`,
`/tmp/opencode/orch/verify-gym-temporal-suite.log`,
`/tmp/opencode/orch/verify-gym-boundary-live.log`, `/tmp/opencode/orch/gym-local-control.mjs`,
`/tmp/opencode/orch/gym-durable-control.log`, `/tmp/opencode/orch/gym-local-refusal.log`,
`/tmp/opencode/orch/p2-default.log`, `/tmp/opencode/orch/p2-local.log`.

---

# verify-3 — independent verification of runtime-2 (the cut, docs, deploy) on `main` @ `231d384`

Worktree: `git worktree add --detach /tmp/opencode/orch/verify-231 231d384`; `rm -rf dist`; root +
`integrations/temporal` install/build (exit 0). Node 22 (`/tmp/opencode/node22/.../bin`,
`v22.20.0`) first on PATH. `gym-wt` not opened; `main` not modified; worktree removed at the end.

**Overall: claims 1, 3, 5, 6 SOLID; claim 2 SOLID with a named survivor (a record type, not the turn
body); claim 4 LIKELY** — the README numbers all reproduce, but the cut left the *other* docs
instructing deleted APIs, and `live:proof` reports SKIP yet exits 0. Details:

## Method 1 — suites under Node 22 (do this first; it is the yardstick)

- ROOT (`npm test` → `node --test dist/test/*.test.js`): **200 tests, 200 pass, 0 fail, 0 skipped**
  once `integrations/temporal` is installed (first run without tsx was 196/4-skip; the 4 skips were
  `tsx not installed`). Logs `/tmp/opencode/orch/verify-231-root.log` (196/4) and
  `verify-231-root2.log` (200/0). **The task's "expected ~228" is wrong: it is 200** — the cut moved
  `v03/v04/v08/v09/runtime/process-crash` tests to `docs/history/museum/` and added
  `durable-stores`/`inference-routing`/`postgres-control`.
- TEMPORAL (`npm test --prefix integrations/temporal`): **80 tests, 80 pass, 0 fail, 0 skipped**.
- `npm run integrations:syntax`: `{"ok":true,"typescriptFiles":81,"syntaxDiagnostics":0,"shellFiles":4}`.
- `integrations/opencode-http-gateway` `npm test`: **3 pass, 0 fail**.

## Method 2 — one-turn-body invariant (attack) — **SOLID**

- Exact-word grep for `AgentRuntime|DurableTurn|runDurableTransactionalTurn|TemporalDurabilityProvider|EffectReconciler|PolicyEffectGate|Supervisor` in `src/`: **NONE**. `src/runtime/`
  now holds only `agent-engine.ts` and `gateway-engine.ts`. The barrel `src/index.ts` exports neither
  the runtime nor any control-plane/supervisor module.
- Only surviving grep hits are `DurableTurnRecord` — a stored-record **type**, not the deleted
  `DurableTurn` class — used by `src/durability/runtime-state.ts:38`, the local/json stores,
  `src/postgres/persistence.ts`, and `src/chaos/wrappers.ts`; and it is reached by
  `ExecutionBroker` for effect receipts (`src/execution/broker.ts:1`) and by `chaos.test.ts`. That is
  the durability *store* layer the README says remains, not a turn body. `integrations/temporal/supervisor/*`
  is the separate Temporal session supervisor (KNOWN-OPEN: built, not deployed), not the deleted
  `src/orchestration/supervisor.ts`.
- Single gateway turn: `integrations/temporal/src/gateway-run-turn.ts:184` constructs
  `createGatewayAgentEngine`, `:200` calls `engine.run(...)`. The only client that builds
  `/v1/chat/completions` in `src/` is `gateway-engine.ts:142`; `inference/gateway/server.ts:120` is
  the server. `durableAgentWorkflow` (`integrations/temporal/src/workflows.ts:38`) proxies `runTurn`
  at `:24` and calls it at `:74`.

## Method 3 — Postgres coverage preserved — **SOLID**

- `test/postgres.test.ts` survives and runs in the root suite (tests 158–166 in the log):
  one-active-owner command claim, effect-claim-prevents-duplicate-executor-calls (executions===1),
  event watermark, CAS stale-revision, shared rate-limit counter, receipt-monotonicity, advisory
  lock-before-DDL. `test/postgres-control.test.ts` (new) adds DB-clock lease acquire/renew/validate
  and hard-fenced agent write (owner/token/DB-expiry) — the v09 fencing test moved here, not lost.
- Live proof, executed against the running Postgres (`synth-audit-pg`,
  `postgres://synth:synth@10.43.101.77:5432/synth`), at the task's own number:
  `SYNTH_POSTGRES_WORKERS=32 npx tsx integrations/postgres/concurrency.ts` →
  `{"ok":true,"workers":32,"commandWinners":1,"effectWinners":1,"leaseWinners":1,"fencingToken":1,
  "dbClockSkewBlocked":true,"hardAgentFencing":true,"casWinners":1}`. Default (16) is identical.
  `smoke.ts` → `{"ok":true,...}`. CI wires exactly this: `.github/workflows/postgres-live.yml` sets
  `SYNTH_POSTGRES_WORKERS: 32` and runs `npm run concurrency` on push/PR.
- Caveat (not a claim failure): the task's "32-worker" is a CI/env choice, not a fixed constant
  (`concurrency.ts:9` defaults to 16; the fault-matrix fixture records a 16-worker run). And a few
  v08/v09 unit tests lost their subject with the deleted modules — `EffectReconciler`
  ("resolves uncertain receipt without replay"), the `AgentRuntime` mailbox-cursor-after-run test,
  and the "stale terminal write after takeover" unit test (the takeover is covered live by the
  generation-A/B check above and the SQL by postgres-control). Report as moved coverage, not silent
  loss of the lease/fencing invariant.

## Method 4 — Docs truth — **LIKELY**

Every README number reproduces: root **200/0**, Temporal **80/0**, syntax **81 files / 0 diag / 4
shell**, opencode-http-gateway **3/0**, Node **>=22** (`package.json` engines + README banner),
release status **1.0.0-rc.1** (`package.json`). The Temporal/adapter diagram matches the code
(workflow → `runTurn` → `GatewayAgentEngine` → execution rung), and the multi-replica claim is
covered by passing tests (`router affinity and cooldown are shared across router replicas`, shared
tenant rate limiting). README's "not enforced per push" list matches `docs/KNOWN-OPEN.md`
(scoring-worker isolation, gym tool path, 8-item corpus, unmeasured OpenRouter limits).

**Overstatement found — the rest of the docs were not brought along.** README line 15/66 says
`AgentRuntime`/`DurableTurn`/`CommandCoordinator`/`LeasedAgentRunner` are gone, and the code agrees,
but these non-history docs still describe them as the live mechanism and were not updated or
bannered by `42e2286`:

- `docs/UPGRADE.md:20` — "Run distributed agents through `LeasedAgentRunner`; it passes ... to
  `AgentRuntime.run()`" (both deleted). A user-facing how-to.
- `docs/INTEGRATION.md:41` — "route runs through `LeasedAgentRunner`".
- `docs/HARDENING.md:5`, `docs/RECOVERY.md:27`, `docs/CODE-REVIEW.md:16`, `docs/RELEASE-GATE.md:7`,
  `docs/ARCHITECTURE.md:65,79,124` (ARCHITECTURE has a historical banner; the others do not).
- `docs/DISTRIBUTED.md`, `docs/TRANSACTIONS.md`, `docs/TEMPORAL.md` still reference
  `CommandCoordinator`.

Only `docs/ARCHITECTURE.md` got the "Historical design doc" banner; `docs/README.md` names some
files as history but not `UPGRADE.md`/`INTEGRATION.md`/`CODE-REVIEW.md`/`RELEASE-GATE.md`. The
commit message says "mark the pre-consolidation design docs historical" — that is only half done.

**Second overstatement:** `scripts/live-proof.mjs:75` exits **0** when there are SKIPs
(`if (results.some FAIL) process.exit(1)`), so a run where 4 of 9 checks never ran is a green exit
code. The summary does print `SKIP` distinctly (README's claim that it "reports SKIP (not PASS)" is
literally true), but it violates the standing rule "a skip is exit 2". Executed: `node
scripts/live-proof.mjs` with Temporal up → `PASS ×5, SKIP ×4, EXIT=0`
(`/tmp/opencode/orch/verify-231-liveproof.log`).

## Method 5 — Deploy — **SOLID with placeholders**

- `deploy/kubernetes/worker-deployment.yaml` is the only `kind: Deployment` under `deploy/`
  (`grep`): one `synth-temporal-worker` workload, `replicas: 1`, no homegrown control-plane replica.
  It runs `node integrations/temporal/dist/integrations/temporal/src/worker-entry.js`; that path
  exists after the integration build. `kubectl apply --dry-run=client -f
  deploy/kubernetes/worker-deployment.yaml` → `configmap/... created (dry run)`,
  `deployment.apps/synth-temporal-worker created (dry run)`, `secret/... created (dry run)`.
- Placeholders remain, as the README/deploy README admit: worker image
  `registry.example/synth-temporal-worker:0.4.0`, Secret `stringData: {}`, and — the task's specific
  question — the executor image in the default classes is **still** `ghcr.io/example/synth-executor:latest`
  (`src/execution/resource-class.ts:97,121,145,169`, `examples/kubernetes-demo.ts:19`); the
  `gym-runner` digest pin (`3e9c060`) is not on `main` and `src/execution/executor-image.ts` does not
  exist here. `deploy/executor-image/Dockerfile` base is also unpinned. Documented as "replace the
  placeholder", but not done.

## Method 6 — live-proof swap (`231d384`) — **SOLID**

- The deleted homegrown crash test is at `docs/history/museum/test/process-crash.test.ts` (not
  compiled/run; root `tsconfig.json` includes only `src`/`examples`/`test`), and `process-crash:contract`
  is gone from `package.json`. `scripts/live-proof.mjs` now runs the Temporal suite and, when
  Temporal is reachable, `npm run live:restart --prefix integrations/temporal`.
- The replacement asserts a discriminating quantity, not a status: `restart-worker.ts` kills the
  worker mid-activity and requires `result === "recovered" && attempts.includes(1) &&
  attempts.some(a => a >= 2)`, exiting 0 only if true. Executed with Temporal on `127.0.0.1:7243`
  (which is up): `{"result":"recovered","attempts":[1,2],"restartedWorkerRecovered":true,"ok":true}`,
  EXIT=0 (`/tmp/opencode/orch/verify-231-restart.log`). Full `live-proof.mjs` includes
  `PASS Temporal worker-restart proof (14820ms)`.

**Repo untouched:** `main` and `gym-wt` not modified; only the `/tmp` worktree (removed) and live
probes. Artifacts: `/tmp/opencode/orch/verify-231-root.log`,
`/tmp/opencode/orch/verify-231-root2.log`, `/tmp/opencode/orch/verify-231-temporal.log`,
`/tmp/opencode/orch/verify-231-restart.log`, `/tmp/opencode/orch/verify-231-liveproof.log`,
`/tmp/opencode/orch/lp2.log`.

---

# verify-4 — failing-first on the heavy-runtime fix, and the rung/harness audit

Node 22 (`/tmp/opencode/node22/.../bin`, `v22.20.0`); Temporal `127.0.0.1:7243`; Postgres
`127.0.0.1:5432` all reachable. Worktrees `/tmp/opencode/orch/verify-c99` (`c99acbb`),
`verify-c99-parent` (`c99acbb^`), `verify-gym2` (`gym-runner` HEAD `cb8ecb2`), all removed at the
end. `gym-wt` not opened; repo not modified.

## 1. Failing-first on `c99acbb` (the heavy-runtime fix) — **SOLID**

`c99acbb` changes only `integrations/temporal/mailbox-property-driver.ts` (+10/-2). Fresh worktree
at each end, `npm install` in root and `integrations/temporal`, run
`TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx mailbox-property-driver.ts`:

- **Parent `c99acbb^` → FAIL, EXIT=1.** The one red entry is exactly the stated one:
  `"fuzz":{"seed":3,"pattern":"bursty",...,"turns":12,"waitingTurns":2,"orderOk":true,"turnsOk":true,
  "deferGapsOk":true,"drainedOk":false,"ok":false}` — `allOk:false`, exactly 1 occurrence of
  `"drainedOk":false`. The other 8 fuzz seeds and all 24 non-fuzz streams are green, so it is not an
  environment/worker failure: the worker ran, recorded 12 batches, and the property held except the
  drain read. Log `/tmp/opencode/orch/verify-c99-parent-driver.log`.
- **Child `c99acbb` → PASS, EXIT=0.** `allOk:true`, all 9 fuzz entries `ok:true`, zero
  `"drainedOk":false`. Seed 3 bursty now shows `turns:13` with the deferred batch consumed by the
  next idle turn — matching the commit message. Log `/tmp/opencode/orch/verify-c99-child-driver.log`.

**The wait was fixed, not the assertion.** The liveness loop changed from
`while (distinct() < stream.length …)` to `while (!(await isDrained()) …)` where `isDrained()` is
`mailbox.length === 0 && status === "idle"` (`mailbox-property-driver.ts:156-161`). `drainedOk` is
still computed from the final state and is still load-bearing:

```
:173  const drainedOk = state?.mailbox.length === 0 && state?.status === "idle";
:198  ok: orderOk && turnsOk && drainedOk && deferGapsOk,
:248  process.exit(allOk ? 0 : 1);
```

Control (never-drain): I copied the child driver and forced the fuzzed activity to always return
`waiting` (so the workflow can never drain), then ran it. Result: `drainedOk:false`, `turnsOk:false`,
`ok:false`, **EXIT=1** — the new wait still fails when the workflow does not drain, so the assertion
was not gutted. Log `/tmp/opencode/orch/verify-c99-neverdrain.log`.

## 2. Is the synthetic rung Temporal-driven and boundary-enforced? — **LIKELY (Temporal-driven yes; "even synth runs" no)**

Call path, with file:line (on `gym-runner` HEAD `cb8ecb2`; note `gym-runner` has not merged the
`main` cut — its `src/runtime/` still holds `agent-runtime.ts`/`durable-turn.ts`/`transactional-turn.ts`
and its `gateway-run-turn.ts` is the pre-`588bb34` raw-HTTP one):

- Durable arm builds the runner in `integrations/temporal/src/gym-activities.ts:49-59`
  (`useSandbox = binding.kind === "sandbox"` → `buildSandboxRunner`), then runs the shared loop
  `runGymAttempt` at `:89` with that runner.
- `buildSandboxRunner` (`integrations/gym/sandbox.ts:118-168`) constructs
  `MemoryWorkspace({ source: LocalDirSource(repoDir) })` (`:133`), `SyntheticExecutor` (`:135`),
  `KubernetesExecutor` with the `sandbox-small` class (`:136`), and
  `new ExecutionBroker([synthetic, real], LocalRuntimeStateStore)` (`:137`), wrapped by
  `brokerEffectRunner` (`:142`).
- `brokerEffectRunner` maps `read`/`write`/`list` to `workspace.read`/`workspace.write`/`workspace.list`
  (`src/gym/tools.ts:74-88`) and `exec` to `process.exec` (`:89-96`).
- `SyntheticExecutor.canExecute` accepts `workspace.*` **and** `process.exec` (`src/execution/synthetic.ts:26-28`),
  but `execute` runs only `workspace.*` against `MemoryWorkspace` and returns
  `{ok:false,error:"ESCALATION_REQUIRED"}` for `process.exec` (`:95-96`). `KubernetesExecutor.canExecute`
  accepts **only** `process.exec` (`src/execution/kubernetes/executor.ts:39-45`). The broker walks
  candidates by fidelity and continues past `ESCALATION_REQUIRED` (`src/execution/broker.ts:67-74`).

Executed probe (`/tmp/opencode/orch/rung-probe.mjs`, against the built `dist/`): a
`workspace.read/write/list` each ran on executor `"synthetic"` (the read returned the bytes of the
host-RAM file), while `process.exec` ran on the fake physical executor (`"pod"`). So **workspace
effects run host-side in `MemoryWorkspace`; only `process.exec` reaches the pod.**

Verdict: the durable arm is Temporal-driven (workflow `gymAttemptWorkflow` →
`runGymAttemptActivity` → `runGymAttempt`), but the design does **not** satisfy "recursive
Temporal-driven sandbox, even synth runs, no exception". The synthetic medium is host RAM inside the
worker/activity process — not durable (only the patch is checkpointed, via
`BlobGymCheckpointStore`) and not sandboxed. The sandbox is a one-shot exec target:
`KubernetesExecutor.execute` creates a pod per `process.exec`, materializes the `MemoryWorkspace`
into it, runs the command, syncs bytes back, and destroys it
(`src/execution/kubernetes/executor.ts:58-93`). The agent's decision loop and its file edits live in
the worker; only individual shell commands are sandboxed.

What "synth-1" would have to change: make the workspace itself live inside the boundary — a
persistent sandbox per attempt (or a durable workspace store the pod mounts) so
`workspace.read/write/list` are effects executed in the pod, not in worker RAM; keep Temporal as the
driver but checkpoint the workspace durably (not just the patch) so a restart resumes a pod with the
same state; and ensure no scored path can fall back to host `localEffectRunner` (already refused,
`gym-activities.ts:35-42`).

## 3. Is the coding harness wired? — **SOLID (confirmed)**

- `PiAgentEngine` (`src/adapters/pi/pi-engine.ts:14`) is exported from the barrel
  (`src/index.ts:33`) but has **no caller**: the only other reference in the whole tree is a comment
  in `integrations/pi-runtime-bridge/harness-session.ts:31`, and that file (`createHarnessSession`)
  is itself imported by nothing. The Pi e2e tests under `integrations/pi-e2e/` are templates
  installed into an external Pi checkout and are not in any `npm test` script; they use Pi's own
  `AgentHarness`, not `PiAgentEngine`.
- The harness that actually runs is the gym's bespoke loop: `runGymAttempt`
  (`src/gym/attempt.ts:165`) builds `createGymTools` (`:182`) and dispatches each model tool call with
  `tools.execute(call)` (`:271`), with tool definitions/prompts from `src/gym/tools.ts`.
- The runtime's triage turn has no tools: `gateway-run-turn.ts` on `main` configures
  `createGatewayAgentEngine` with only `systemPrompt` and `buildUserMessage`
  (`integrations/temporal/src/gateway-run-turn.ts:192-193`) — no `parseToolCalls`, no `toEffect`, and
  `buildTurnContext` supplies no `executeEffect`. On `gym-runner` the triage turn is the older
  raw-HTTP path, also tool-less.

Consequence for what the gym measures: the scored loop is a bespoke tool-calling harness over a
one-shot `process.exec` sandbox, not the runtime's own agent engine (`PiAgentEngine`) driving the
execution rung. The gym therefore measures model + bespoke-loop + gateway + sandboxed-command
dispatch; it does not exercise `PiAgentEngine`, the runtime's mailbox/turn path, or a persistent
sandboxed workspace. The `GatewayAgentEngine` turn body and the gym loop are two different tool
pipelines.

**Repo untouched:** `main` and `gym-wt` not modified; only the `/tmp` worktrees (removed) and probes.
Artifacts: `/tmp/opencode/orch/verify-c99-parent-driver.log`,
`/tmp/opencode/orch/verify-c99-child-driver.log`, `/tmp/opencode/orch/verify-c99-neverdrain.log`,
`/tmp/opencode/orch/rung-probe.mjs`.

---

# audit-1 — hallucination audit (read-only) @ `c99acbb` — summary

Full report: **`/tmp/opencode/orch/audit-hallucinations.md`** (module table, claim table, missing
headline experiment, top-10). Read-only; worktree `/tmp/opencode/orch/verify-audit` removed at end.

**LIKELY (audit is solid; the repo's honesty is mixed).** Reproduced at `c99acbb`: root **200/200**,
temporal **80/80**, syntax **81 TS / 0 diag / 4 shell**, opencode-http-gateway **3/3**, secret-scan
clean; live Postgres **32 workers** all-one-winner + `hardAgentFencing=true`, restart proof
`attempts=[1,2]`, k8s pod-kill `exitCode=137`.

- **Real and wired:** `GatewayAgentEngine` turn body (the only one), Temporal worker/interceptors,
  Postgres persistence + fencing coverage, execution rungs, workspace/artifacts.
- **Orphaned but exported + documented (QUARANTINE):** `src/world/*`, `src/chaos/*`,
  `src/durability/{local-memory,json-file-durability,json-file-runtime-state}.ts`,
  `src/workspace/transaction.ts`, `src/adapters/pi/pi-engine.ts`,
  `integrations/pi-runtime-bridge`, `integrations/pi-synthetic-git-prototype`. `json-file-durability.ts`
  has no caller at all.
- **Overclaimed:** "verified live" Pi E2E and external-provider matrix (no artifact; `docs/PI-E2E.md:40`
  admits not executed); "model-authored code only ever runs through the execution rung" (workspace
  effects run host RAM); "Postgres remains the store for mailbox cursors/world revisions" (worker
  never reads Postgres); gVisor proof listed with CI proofs but `kubernetes-live.yml` is
  `workflow_dispatch` and the live-proof runners exit 0 on skip-only.
- **Stale docs (FALSE):** `docs/RELEASE-GATE.md` certifies deleted `LeasedAgentRunner`/
  `CommandCoordinator`; `docs/LIVE-PROOF.md:10` still shows the deleted SIGKILL test and line 24 says
  16 workers vs README's 32; `docs/LIVE-CONTRACTS.md` lists removed contracts as always-runnable;
  16 non-history docs reference deleted modules/scripts.
- **Missing headline experiment:** no artifact shows a real model solving a real task **through the
  sandbox** and being scored. Closest: `/tmp/opencode/GYM-P2-RESULTS.md` (real model, real task,
  scored — but `runner=local`) and `integrations/gym/sandbox-live.ts` (real gVisor pod — but zero
  model calls).

Artifacts: `/tmp/opencode/orch/audit-hallucinations.md`, `/tmp/opencode/orch/audit-root.log`,
`/tmp/opencode/orch/audit-temporal.log`, `/tmp/opencode/orch/audit-ocg.log`.

---

# verify-5 — runtime-3's three commits (`2761353`, `feffeb5`, `d959ef6`)

Node 22; Temporal `127.0.0.1:7243`; Postgres `127.0.0.1:5432`. Worktrees at `c99acbb` (`2761353^`),
`2761353`, `d959ef6`, all removed at the end. Repo untouched.

## 1. `2761353` "Durable turn: carry turnConfig and execute tool calls through the rung" — **LIKELY (feature works, commit does not build)**

**Call path (at `d959ef6`):** `durableAgentWorkflow` → `runTurn` with `config`
(`workflows.ts:74-78`) → `gateway-run-turn.ts:339` resolves the rung
(`options.rungFactory ?? defaultRungFactory`) → `:356` `toEffect: buildToEffect(config.tools)` →
`:207` `buildTurnContext(..., rung)` sets `executeEffect` → `:362` `engine.run(...)` →
`src/runtime/gateway-engine.ts:187` maps each call via `toEffect`, `:189` the guard
`if (!effect || !context.executeEffect)`, `:194` `await context.executeEffect(effect)` → rung
`executeEffect` → `ExecutionBroker.execute` (`gateway-run-turn.ts:287` synthetic, `:308`) →
`SyntheticExecutor`/`KubernetesExecutor`.

**Failing-first (independent probe `/tmp/opencode/orch/v5-tool-probe.mts`, not the repo test):**
- `c99acbb` (`2761353^`): `executorCalls: 0`, the turn **throws** —
  `model reply has no "events" array: {"tool_calls":[…]}`. The tool reply is never executed; the
  parent activity still parses classifications and errors. (The engine also refuses the calls first:
  no `toEffect` at parent → `"No execution rung mapping for tool"`; the task's quoted
  `"No effect executor configured"` is the child's *no-rung* control, not the parent.)
- `2761353` **with `executor-image.ts` supplied** and at `d959ef6`: `executorCalls: 2`,
  `resultKeys: [content, toolCalls, observations, latencyMs]`, observations
  `write_file ok=true`, `read_file ok=true output="tool-bytes"`.

**The commit as committed is red.** `2761353:integrations/temporal/src/gateway-run-turn.ts:5`
imports `../../../src/execution/executor-image.js`, which **does not exist at `2761353`** (nor at
`feffeb5`; it is added in `d959ef6`). Clean committed-state run at `2761353`:
`npm run build` → **exit 2**, `src/gateway-run-turn.ts(5,32): error TS2307: Cannot find module
'../../../src/execution/executor-image.js'`; `npm test` → **59 tests, 57 pass, 2 fail**
(`test/gateway-run-turn.test.ts`, `test/mailbox-generator.test.ts`). The commit message's "Red
before the change, green after. Temporal suite 82/82" is **not true at `2761353`**; 82/82 holds only
at `d959ef6` (verified: 82/82). So the failing-first pair the task asks for exists, but the green
half lives two commits late, not in `2761353`.

**One turn body invariant: SOLID.** Only `gateway-run-turn.ts:344` and `examples/demo.ts:21` create
the engine. The only client that builds `/v1/chat/completions` is `src/runtime/gateway-engine.ts:142`;
`src/inference/gateway/server.ts:120` is the server; there is **no `fetch(` in
`integrations/temporal/src`**. The other `chat/completions` strings are the flaky-gateway fault
harness, the `rate-limit-scope` live probe, and the server-side OpenCode adapter.

## 2. `feffeb5` "durable-resume proof" — **SOLID**

Executed at `d959ef6` with Temporal up (`/tmp/opencode/orch/v5-durable-restart.log`, EXIT=0):
```
committedCalls: 1, hangCalls: 2, attempts: [1, 1, 2],
committedNotRerun: true, hungTurnRetried: true,
finalStatus: "idle", mailboxLength: 0, ok: true
```

- **It kills the workflow worker, not just an activity.** `killWorker(first)` SIGKILLs the child's
  process group (`durable-restart-worker.ts:60-66`); the child fixture runs `runTemporalWorker` with
  `workflowsPath: ../../src/workflows.ts` and starts the **real** `durableAgentWorkflow`
  (`durable-restart-worker.ts:74`). Turn A commits; turn B hangs on attempt 1 (no heartbeat); the
  worker is SIGKILLed mid-activity; a fresh worker retries turn B after the 1-minute heartbeat
  timeout.
- **The assertion discriminates.** It counts per-message activity invocations from the attempts file
  (`:105-110`): `committedCalls === 1` (a re-derived workflow would append a second "committed" line →
  fail), `hangCalls === 2` (attempts [1,2]), `ok = committedNotRerun && hungTurnRetried && drained`,
  `process.exit(ok ? 0 : 1)` (`:128`). This is a call-count assertion, not a status.
- **Failing-first:** `durable-restart-worker.ts`, its child fixture, the `live:durable-restart`
  script, and the `live-proofs.mjs` entry are all **absent at `2761353`**.
- Caveat: at its own commit `feffeb5` the temporal package build is red for the same missing
  `executor-image.ts`, though the proof itself (tsx, no `gateway-run-turn` import) runs.

## 3. `d959ef6` leftovers

**3a. Skip contract — fixed for one of two scripts.** `scripts/live-proof.mjs:78` now
`if (results.some SKIP) process.exit(2)`. Executed with Temporal up:
`PASS ×5, SKIP ×4 (Postgres/Pi/K8s/gateway), EXIT=2` (`/tmp/opencode/orch/v5-liveproof.log`).
`scripts/live-proofs.mjs` was **not** changed: `:182` is still
`process.exit(failures > 0 ? 1 : 0)`. Executed with two postgres proofs and no `SYNTH_POSTGRES_URL`:
`passed 0  skipped 2  failed 0` → **EXIT=0** (`/tmp/opencode/orch/v5-liveproofs.log`). So an
all-skip `live-proofs.mjs` run is still indistinguishable from success by exit code.

**3b. Executor image — SOLID.** All four default classes use `EXECUTOR_IMAGE`
(`resource-class.ts:99,123,147,171`), `examples/kubernetes-demo.ts:20` defaults to it, the new
`src/execution/executor-image.ts:23` pins
`ghcr.io/taituo/synth-executor@sha256:fc59cec2…`, and `deploy/executor-image/Dockerfile:3` pins the
base `node:22-bookworm-slim@sha256:48e4b67d…`. `ghcr.io/example/...` is gone from non-history,
non-dist files (grep clean). Both digests were independently confirmed real in verify-2/audit-1
(slim = current Docker Hub index; executor = the image imported into the k3s cluster).

**3c. Docs banners — bannered, not fixed.** `d959ef6` adds a consolidation banner to `UPGRADE.md`,
`INTEGRATION.md`, `HARDENING.md`, `RECOVERY.md`, `CODE-REVIEW.md`, `RELEASE-GATE.md`,
`DISTRIBUTED.md`, `TRANSACTIONS.md`, `TEMPORAL.md` (and ARCHITECTURE.md already had one). Only
`TEMPORAL.md`'s body was actually rewritten (the stale `CommandCoordinator` redelivery rule is
gone). Every other doc still tells the reader to call deleted code in its body:

- `docs/UPGRADE.md:29` — "Run distributed agents through `LeasedAgentRunner`; … `AgentRuntime.run()`".
- `docs/INTEGRATION.md:50` — "route runs through `LeasedAgentRunner`".
- `docs/HARDENING.md:14` (`LeasedAgentRunner` → `AgentRuntime.run()`), `:16` (`CommandCoordinator`).
- `docs/RECOVERY.md:28` (`CommandCoordinator.reconcile()`, `EffectReconciler`), `:36`
  (`LeasedAgentRunner`).
- `docs/CODE-REVIEW.md:25,35,43,47,58` (`LeasedAgentRunner`, `CommandCoordinator`,
  `EffectReconciler`, `AgentRuntime.send()/#setState()`).
- `docs/RELEASE-GATE.md:16,21` (`LeasedAgentRunner`, `CommandCoordinator` as closed gates).
- `docs/DISTRIBUTED.md:22` (`AgentRuntime.spawn()`), `:34` (`CommandCoordinator`).
- `docs/TRANSACTIONS.md:14,57,62` (`DurableTurn`, `CommandCoordinator`, `EffectReconciler`).
- `docs/ARCHITECTURE.md:43,65,73,79,124` (`AgentRuntime.spawn/run`, `LeasedAgentRunner`,
  `CommandCoordinator`).

The banners say "References below to those APIs are historical", which warns a careful reader, but
the imperative sentences remain. By the task's standard ("bannered is not fixed if it still tells a
reader to call deleted code"), 8 docs + ARCHITECTURE remain findings; `TEMPORAL.md` is the only one
actually fixed.

**Numbers at `d959ef6` (reproduced):** root **200/200/0**, temporal **82/82/0**, syntax
**83 TS / 0 diagnostics / 4 shell** — all match README:150-156.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v5-tool-probe.mts`,
`/tmp/opencode/orch/v5-276-build.log`, `/tmp/opencode/orch/v5-276-temporal-committed.log`,
`/tmp/opencode/orch/v5-durable-restart.log`, `/tmp/opencode/orch/v5-liveproof.log`,
`/tmp/opencode/orch/v5-liveproofs.log`, `/tmp/opencode/orch/v5-root.log`.

---

# verify-6 — the Temporal graph harness (`8fe75d0`, `bea0184`)

Node 22; Temporal `127.0.0.1:7243`. Worktrees at `bea0184`, `8fe75d0`, `d959ef6` (`8fe75d0^`), all
removed. Repo untouched.

## 1. `8fe75d0` "Add the Temporal graph harness: loops, fan-out/join, branches" — **SOLID**

**It is workflow code, not an in-process loop.** The workflow is
`integrations/temporal/src/graph-workflow.ts:78` `runGraphWorkflow`, registered through the Temporal
`workflowsPath` in the proof fixture (`test/fixtures/graph-restart-worker-child.ts`,
`workflowsPath: ../../src/graph-workflow.ts`) and started by function reference
(`graph-restart-worker.ts:100`). It imports only `@temporalio/workflow` primitives
(`proxyActivities`, `executeChild`, `setHandler`, `defineSignal`, `defineQuery`, `continueAsNew`) and
uses `proxyActivities<AgentActivities>` for `turn` nodes (`:50-54,67-71`), `executeChild` for `child`
nodes (`:73-75`). The interpreter `graph.ts` has **no Temporal imports** (pure), so the same
`executeGraph` runs inside the workflow isolate and in a unit test.

**Semantics attacked with an independent probe** (`/tmp/opencode/orch/v6-graph-probe.mjs`, against
`graph.ts`, handlers with real timers):
- fan-out: `leftInterval=[t,t+200]`, `rightInterval=[t,t+200]`, `wallMs=201` (not 400), `overlaps=true`
  — the two branches ran **concurrently** and the join waited for both. Code: `graph.ts:115`
  `Promise.all(step.steps.map(...))`.
- loop: 3 `iter` calls, stopping on `until {path:"iter.result.count", equals:3}` — a durable
  workflow-state counter (`graph.ts:124-135`, `scope.iteration`).
- branch: `then` taken, `else` not (`graph.ts:118-123`).

**The repo's graph test:** `integrations/temporal/test/graph.test.ts` at `8fe75d0` → **7 tests, 7
pass** (`/tmp/opencode/orch/v6-graph-8fe.log`); it asserts loop count 3, `left`/`right` once each,
`then` chosen / `else` not, activity/child dispatch, nested graph, and the `onNode` hook. Temporal
suite at `8fe75d0` = **89/89**.

**Failing-first:** the interpreter/workflow/test do not exist at `8fe75d0^` (`d959ef6`). Transplanting
`graph.test.ts` onto `d959ef6` fails with
`ERR_MODULE_NOT_FOUND: Cannot find module '.../src/graph.js'` (0 pass / 1 fail); at `8fe75d0` it is
7/7. The proof files and `docs/HARNESS.md` are also absent at `8fe75d0`.

**One wiring note (not an overclaim):** only the proof fixture registers `runGraphWorkflow`; the
shipped `worker-entry.ts` still points `workflowsPath` at `workflows.js`, so a deployment must add
the graph module to its worker. `docs/KNOWN-OPEN.md` lists the gym-driving-harness work as open.

## 2. `bea0184` "Prove the graph survives a worker restart" — **SOLID**

Ran the live proof (`/tmp/opencode/orch/v6-graph-restart.log`, EXIT=0):
```
status: "completed", preCalls: 1, iterCalls: 3, leftCalls: 1, rightCalls: 1, hangCalls: 2,
attempts: [pre#1, iter#1, iter#1, iter#1, left#1, right#1, hang#1, hang#2],
completedIterations: 3, committedNodesNotRerun: true, inFlightNodeRetried: true, ok: true
```
The raw numbers match the claim exactly.

- **Would it pass on a re-deriving graph? No.** `ok` requires `preCalls===1 && iterCalls===3 &&
  leftCalls===1 && rightCalls===1 && hangCalls===2 && completedIter===3`
  (`graph-restart-worker.ts:129-136`), and `process.exit(ok ? 0 : 1)` (`:157`). A workflow that
  re-ran committed nodes would append extra `pre`/`iter`/`left`/`right` lines and fail. The counts
  are per-node activity invocations from the attempts file (`:145-152`), a discriminating quantity,
  not a status.
- **The kill targets the workflow worker.** `killWorker(first)` SIGKILLs the child's whole process
  group (`:61-66`); the child runs `runTemporalWorker` with the graph workflow and the activities
  (`test/fixtures/graph-restart-worker-child.ts`). `hang` runs after the join, blocks on attempt 1
  with no heartbeat, and is killed in flight; a fresh worker retries it after the 1-minute heartbeat
  timeout (`hang#2`).
- **Failing-first:** `graph-restart-worker.ts`, its child fixture, `docs/HARNESS.md`, and the
  `graph-restart` entry in `scripts/live-proofs.mjs` are all absent at `8fe75d0`.

**Honest limits hold.** `docs/HARNESS.md:3-8` states child workflows and continue-as-new are "wired
and unit-tested at the dispatch/hook level but not yet live-proven"; `:62-66` lists the live nested
child proof, compensation/timeouts, and human-in-the-loop as not done; `CHANGELOG.md` says the same;
`docs/KNOWN-OPEN.md:9-14` lists `continueAsNew` at the threshold, `cancelGraph` against a real long
loop, and child workflows as still only unit-tested. No README/CHANGELOG/doc claim them as proven —
the README:68-75 and CHANGELOG:16 text only describes the code (a `cancelGraph` signal exists, it
calls `continueAsNew` after N nodes), and the README's only proof sentence is the SIGKILL loop/join
one, which is exactly what ran.

## 3. Numbers + honesty — **SOLID**

- `bea0184`: temporal **89/89/0 skip** (`/tmp/opencode/orch/v6-main-temporal.log`), `integrations:syntax`
  **88 TS / 0 diagnostics / 4 shell** — both match README:150-156. Parent `d959ef6`: temporal 82.
- `docs/HARNESS.md` is accurate, mapped to code:
  - `GraphStep` kinds (`HARNESS.md:20-26`) ↔ `graph.ts:26-34`; conditions `{path,equals}`
    (`:28-30`) ↔ `graph.ts:19-24,77-79`; fanout `Promise.all` (`:24`) ↔ `graph.ts:115`;
    loop counter (`:26`) ↔ `graph.ts:124-135`.
  - `runGraphWorkflow`, `cancelGraph` signal, `getGraphState` query (`:34-38`) ↔
    `graph-workflow.ts:29-30,78,89-90`; `CONTINUE_AS_NEW_AFTER_NODES` 1000 (`:40-42`) ↔
    `graph-workflow.ts:33,98,106`.
  - `executeGraph` pure + `onNode` (`:46-49`) ↔ `graph.ts:86-97`.
  - "7 unit tests" (`:53-55`) ↔ `graph.test.ts` (7 tests); the live proof (`:56-60`) ↔ the run above.
- Only cosmetic nit: `graph-workflow.ts:16` imports `condition` from `@temporalio/workflow` but never
  uses it (cancel is a flag + `onNode` throw, as documented). No effect on the claims.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v6-main-temporal.log`,
`/tmp/opencode/orch/v6-graph-8fe.log`, `/tmp/opencode/orch/v6-graph-parent.log`,
`/tmp/opencode/orch/v6-graph-restart.log`, `/tmp/opencode/orch/v6-graph-probe.mjs`.

---

# verify-7 — quarantine-1 (`0c91437`, `68645c8`)

Node 22. Worktrees at `68645c8` and `bea0184` (`0c91437^`), both removed. Repo untouched (I broke
and restored `src/execution/broker.ts` only inside the `/tmp` worktree; `git status` clean).

## 1. `0c91437` "Quarantine the unwired modules" — **SOLID in source, but the committed `dist/` still ships them**

**Zero-reference grep reproduced.** Grepping the active tree (excluding `docs/history`, `dist/`,
`node_modules`) for `chaos/faults`, `chaos/wrappers`, `durability/local-memory`,
`json-file-durability`, `json-file-runtime-state`, `world/in-memory-world`, `world/json-file-world`,
`adapters/pi/pi-engine`, `pi-runtime-bridge`, `pi-synthetic-git-prototype`, `PiAgentEngine`,
`LocalMemoryDurability`, `JsonFileDurability`, `JsonFileRuntimeStateStore`, `InMemoryWorldStore`,
`JsonFileWorldStore`, `ChaosController` → **no hits**. The files are under
`docs/history/museum/{src,test,integrations}/`, removed from `src/index.ts` (diff removes 10
`export *` lines), and the root `tsconfig.json` includes only `src|examples|test/**/*.ts`, so museum
code is not compiled. Load-bearing modules are intact and imported: `src/execution`,
`src/workspace`, `src/inference`, `src/gym/scoring`, `src/postgres/persistence.ts`,
`src/runtime/gateway-engine.ts`, `src/world/types.ts`, `src/durability/{runtime-state,local-runtime-state,types}`,
`src/control-plane/{lease,mailbox}`, and the Temporal integration (`gateway-run-turn.ts`,
`graph-workflow.ts`).

**The ported assertion is load-bearing.** `test/durable-stores.test.ts:87-105` (plain throwing
`Executor`, `ExecutionBroker` + `LocalRuntimeStateStore`) asserts the executor runs once, the second
`execute` does **not** re-run it (`executions === 1`), and the result is
`{ok:false, error:/EFFECT_OUTCOME_UNCERTAIN/}`. Attack: I made the broker's catch block persist a
`committed` receipt instead of leaving it `started`/uncertain, rebuilt, ran
`node --test dist/test/durable-stores.test.js` → **`not ok 7`, expected false / actual true**
(`second.ok` was true). Restored with `git checkout` → 7/7. So a port that cannot fail does not apply
here. (A first, weaker attack that removed only the pre-check `started` short-circuit did *not* flip
the test — `claimEffect` is a second layer — which is why the catch block is the right place to
break.)

**DEFECT — the quarantine is incomplete in the committed tree.** `dist/` is tracked, and `0c91437`
did not touch it (`git diff bea0184 68645c8 -- dist` is empty). At `68645c8` the committed tree still
contains **16 compiled artifacts of the quarantined modules**:
`dist/src/chaos/{faults,wrappers}.{js,d.ts}`, `dist/src/adapters/pi/pi-engine.{js,d.ts}`,
`dist/src/durability/{local-memory,json-file-durability,json-file-runtime-state}.{js,d.ts}`,
`dist/src/world/{in-memory-world,json-file-world}.{js,d.ts}`, plus `dist/test/chaos.test.js`. The
committed `dist/src/index.js` still exports them (lines 19,25,37,45,50,51,57,58) **and** the
long-deleted `./chaos/scenario.js` (line 59). Consequence, executed: restore the committed `dist/`,
run a plain `npm test` (no `rm -rf dist`; `tsc` does not prune stale outputs) → **191 tests, 190
pass, 1 FAIL** — the stale `dist/test/chaos.test.js` runs and dies with
`SyntaxError: The requested module '../src/index.js' does not provide an export named 'ChaosController'`
(`/tmp/opencode/orch/v7-root-stale.log`). The claimed **190/190 holds only after `rm -rf dist`**
(verified: 190/190). Fix: delete the tracked `dist/` copies of the quarantined modules (or stop
tracking root `dist/`). Note STANDING-ORDERS #8 already tells reviewers to `rm -rf dist`, so this
does not invalidate the claim under the agreed method — but a fresh clone's `npm test` is red.

## 2. `68645c8` "Docs honesty" — **LIKELY (numbers good; deleted-API instructions mostly remain)**

**Numbers reproduced at `68645c8`:** root **190/190/0 skip** (`/tmp/opencode/orch/v7-root.log`),
temporal **89/89/0** (`/tmp/opencode/orch/v7-temporal.log`; first run flaked one heartbeat-timing
assertion, then 89/89 twice and 3/3 in isolation), `integrations:syntax` **81 TS / 0 diagnostics / 3
shell** (shell dropped 4→3 because `pi-synthetic-git-prototype/apply.sh` moved to the museum),
opencode-http-gateway **3/3**. README states exactly these (`README.md:164,167,170,171,174`).

**Deleted-API instructions:** the commit replaced the live instructions in `UPGRADE.md:29` (now says
the helpers "are gone") and `INTEGRATION.md:47` (now routes through Temporal); `TEMPORAL.md`'s body
was already fixed in `d959ef6`. But **7 docs still tell a reader to call deleted code** (banner text
"References below to those APIs are historical" is not a fix):

- `docs/HARDENING.md:14` — "`LeasedAgentRunner` passes … into `AgentRuntime.run()`"; `:16` —
  "`CommandCoordinator` validates its lease".
- `docs/RECOVERY.md:28` — "A stale `started` command requires `CommandCoordinator.reconcile()`. A
  stale effect requires an effect-specific `EffectReconciler` probe."; `:36` — "`LeasedAgentRunner`
  adds renewable ownership…".
- `docs/CODE-REVIEW.md:25,35,43,47,58` — `LeasedAgentRunner`, `CommandCoordinator`,
  `EffectReconciler`, `AgentRuntime.send()`, `AgentRuntime.#setState()`.
- `docs/RELEASE-GATE.md:16,21` — "carry a fencing generation under `LeasedAgentRunner`",
  "`CommandCoordinator` validates…".
- `docs/DISTRIBUTED.md:22` — "`AgentRuntime.spawn()` treats a `false` …"; `:34` — "`CommandCoordinator`
  is the safe path…".
- `docs/TRANSACTIONS.md:14` ("## DurableTurn"), `:57` ("`DurableTurn` + durable `ExecutionBroker`
  receipts is the v0.4 reference pattern"), `:62` ("belongs to `CommandCoordinator`; uncertain
  effects … through `EffectReconciler`").
- `docs/ARCHITECTURE.md:43,65,73,79,124` — `AgentRuntime.spawn/run`, `LeasedAgentRunner`,
  `CommandCoordinator`.

So of the audit's 10-doc list, 3 are clean (UPGRADE, INTEGRATION, TEMPORAL) and **7 remain**. The
commit message "remove deleted-API instructions" is true only for the two it edited.

## 3. Pi decision — **SOLID**

`docs/KNOWN-OPEN.md` now records it explicitly: "**Pi is quarantined, not wired.** `PiAgentEngine`
and `integrations/pi-runtime-bridge/` had no caller and are in `docs/history/museum/`. Re-wiring them
as the harness would need the Pi packages (not in this repo) and would have to route turns through
the shared `GatewayAgentEngine`/`runTurn` path rather than a second turn body." `README.md` now says
"There is no bundled agent harness: the former `PiAgentEngine` and Pi bridge had no caller and are
quarantined". No doc claims Pi is a live harness. The one residual: README's RC sentence still says
the RC "was exercised against … a pinned Pi checkout E2E", but it is now immediately qualified as a
historical run with the adapter quarantined, and `docs/PI-E2E.md:40` still admits those tests were
not executed in the artifact environment. The decision is coherent; the unbacked historical claim is
disclosed, not hidden.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v7-root.log`,
`/tmp/opencode/orch/v7-root-stale.log`, `/tmp/opencode/orch/v7-temporal.log`,
`/tmp/opencode/orch/v7-attack3-test.log`, `/tmp/opencode/orch/v7-attack3-build.log`,
`/tmp/opencode/orch/v7-hb-1.log`.

---

# verify-8 — providers-1 (`b3f1ef6`) and gym-2 (`a6109b5`, `8c76f72`)

Node 22; Temporal `127.0.0.1:7243`. Worktrees at `b3f1ef6` (main), `8c76f72` (gym-runner),
`fec8c76` (`a6109b5^`), all removed. Repo untouched.

## 1. `b3f1ef6` "providers come from configuration" — **SOLID**

**Config path.** `integrations/temporal/src/worker-entry.ts` defines `resolveProvider()`:
`providersFromEnv()` → if any, `selectProvider({providers}, GATEWAY_MODEL) ?? providers[0]` →
`directProviderSettings(provider)`; else the `GATEWAY_BASE_URL`/`GATEWAY_MODEL`/`GATEWAY_API_KEY`
fallback. The functions are `src/inference/gateway/provider-config.ts:90` (`providersFromEnv`), `:163`
(`selectProvider`), `:171` (`directProviderSettings`), `:51` (`parseGatewayConfig`), `:122`
(`buildProviderRouter`). `runTurn: createGatewayRunTurn(resolveProvider())`.

**Attack (executed end-to-end).** Two fake OpenAI-compatible servers (`v8-fake-server.mjs`, ports
8891/8892, each logging `label path model=`), the **real compiled `worker-entry.js`**, and a real
`durableAgentWorkflow` client. Changing only env changed the provider:

| env | calls observed (server log) | workflow |
|---|---|---|
| `SYNTH_GATEWAY_PROVIDERS=[alpha@8891, beta@8892]`, `GATEWAY_MODEL=beta` | `beta POST /v1/chat/completions model=beta-model` (1) | completed, classifications returned |
| same, `GATEWAY_MODEL=alpha` | `alpha POST /v1/chat/completions model=alpha-model` (1) | completed |
| same, no `GATEWAY_MODEL` (default) | `alpha … model=alpha-model` (first declared) | completed |
| `SYNTH_PROVIDER_ALPHA_*`/`SYNTH_PROVIDER_BETA_*` env form, `GATEWAY_MODEL=beta` | `beta … model=beta-model` | completed |
| fallback `GATEWAY_BASE_URL=8892`, `GATEWAY_MODEL=beta-model` | `beta … model=beta-model` | completed |

Exactly one model HTTP call per case, and only the selected server received it — the discriminating
quantity (which server, which model), not a status.

**No hardcoded provider/key.** Grep over `src/` + `integrations/temporal/src` for provider ids,
`sk-…`, `bearer …`, and `apiKey: "…"` literals finds only comments/docs and one router header alias
(`profile-router-backend.ts:183` falls back to `x-opencode-session`). No provider is used as a code
path.

**Direct path imports no opencode/Pi adapter.** `provider-config.ts:17-19` imports only
`http-upstream.js`, `profile-router-backend.js`, `types.js`; `worker-entry.ts:1-8` imports
`provider-config.js`, `gateway-run-turn.js`, `worker.js`. No `opencode`/`PiAgentEngine`/`@earendil`
import anywhere on the path.

**Disclosed limit is real and stated.** `docs/KNOWN-OPEN.md` (Runtime and deploy): "Per-run provider
selection is an API, not yet threaded through the turn config … `DurableTurnConfig` carries the model
but not a provider id." `docs/INFERENCE.md` says the worker "selects a provider from this config at
startup". Both accurate: `worker-entry.ts` selects once at startup.

**Numbers at `b3f1ef6`:** root **196/196/0 skip** (`provider-config.test.ts` adds 6), temporal
**89/89/0**, syntax **81 TS / 0 diagnostics / 3 shell** — README:164-174 states exactly these.

## 2. `a6109b5` + `8c76f72` gym one turn body — **SOLID**

**Call path, file:line.** `gymAttemptWorkflow` (`integrations/temporal/src/gym-workflows.ts:47`) builds
the attempt as one mailbox message and calls `executeChild(durableAgentWorkflow, …)` (`:78`); the
runtime `durableAgentWorkflow` proxies the gym's `runTurn` (`gym-activities.ts:159`), which parses the
params and runs `runGymAttemptActivity` → `runGymAttempt` → `createGatewayGymTurn`
(`src/gym/turn.ts:181`) → `createGatewayAgentEngine` (`turn.ts:~200`) → `GatewayAgentEngine` (the one
body; its only request builder is `gateway-engine.ts:142`) → the sandbox rung's `process.exec`
(gVisor pod). `gym-workflows.ts` re-exports `durableAgentWorkflow`/signals so the child type is
registered.

**Grep proof.** At `8c76f72`, `chat/completions` appears in gym code only in a comment
(`src/gym/turn.ts:9`); no `fetch(` in `src/gym`/`gym-*` except `run-gym.ts:114` (gateway preflight,
`/v1/models`), which is not a turn.

**Failing-first.** At `a6109b5^` (`fec8c76`), `src/gym/turn.ts:176` built
`${baseUrl}/v1/chat/completions` and `:195` did its own `doFetch` — a second turn body; and
`gym-activities.ts` had no `runTurn` activity. Transplanting the new `test/gym-durable-path.test.ts`
onto `fec8c76` → **3 pass / 2 fail**: `not ok 4 - gym-worker.ts registers the gym workflow and its
activity` ("the orchestrator must start the runtime agent workflow") and `not ok 5 - there is exactly
one gateway turn body…` ("the gym turn must construct the shared engine"). At `8c76f72` the gym
temporal suite is **86/86**. The one-body test also asserts `src/gym/turn.ts` does **not** match
`/fetch\(|doFetch|AbortSignal\.timeout/` — the exact regression.

**The disclosed gap is real and honestly stated.** `docs/GYM-ONE-TURN.md:45-59`: "the loop is still
inside the activity … a two-turn attempt produced `turns: 2`, `callCount: 2`, `modelHttpRequests: 2`,
but **`runTurnActivities: 1`**", with the failing assertion
`assert.equal(runTurnActivities, out.turns); // 2 !== 1 today`. The measured artifact
`/tmp/opencode/gym2-multiturn-gap.log` says `{"outcome":"passed","turns":2,"callCount":2,
"modelHttpRequests":2,"runTurnActivities":1}` and "GAP: 2 turns ran inside 1 runTurn activity
call(s)". The doc does **not** claim turn-per-activity; it names the gap and a sketch. The one-body
evidence (`/tmp/opencode/gym2-trace-proof.log`) shows `MODEL_HTTP_REQUESTS=1`,
`HISTORY_CHILD_WORKFLOW_TYPES=["durableAgentWorkflow"]`, `CHILD_HISTORY_ACTIVITY_TYPES=["runTurn"]`,
outcome `passed`/`gvisor`/358 B, `run_visible_test` PASS in the pod.

## 3. Docs residual at `main` HEAD `b3f1ef6` — **unchanged from verify-7: 7 of 10**

`b3f1ef6` touched only README/INFERENCE/KNOWN-OPEN/CHANGELOG, so the deleted-API instructions remain
exactly as verify-7 found. Still telling a reader to **call** deleted APIs:

- `docs/HARDENING.md:14,16` · `docs/RECOVERY.md:28,36` · `docs/CODE-REVIEW.md:25,35,43,47,58` ·
  `docs/RELEASE-GATE.md:16,21` · `docs/DISTRIBUTED.md:22,34` · `docs/TRANSACTIONS.md:14,57,62` ·
  `docs/ARCHITECTURE.md:43,65,73,79,124`.

Clean (banner + body): `docs/UPGRADE.md` and `docs/INTEGRATION.md` (body fixed in `68645c8`),
`docs/TEMPORAL.md` (body fixed in `d959ef6`). So the list is still **7 of 10**.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v8-root.log`, `/tmp/opencode/orch/v8-temporal.log`,
`/tmp/opencode/orch/v8-gym-temporal.log`, `/tmp/opencode/orch/v8-calls.log`,
`/tmp/opencode/orch/v8-gym-parent-test.log`, `/tmp/opencode/orch/v8-fake-server.mjs`,
`/tmp/opencode/orch/v8-attack.sh`.

---

# verify-9 — synth-1 (`b4560c5`, `e19a573`) workspace effects in the Pod

**Verdict: SOLID** for the core claim (sandbox-rung `workspace.read/write/list` execute inside the
Pod, live gVisor proof). One documentation overclaim (README says a scored run refuses the synthetic
rung via `assertRungAllowedForScored`; that function has **no production caller**). Node 22,
Temporal `127.0.0.1:7243`, k3s `gvisor` RuntimeClass, executor image pinned by digest
`…@sha256:fc59cec2…`. Worktrees `v9-head` (`e19a573`), `v9-b4560c5`, `v9-parent` (`b3f1ef6`), all
removed. Repo untouched.

## 1. Call path — **SOLID**

`integrations/temporal/src/gateway-run-turn.ts:294` `sandboxRung()` builds the executor list as
`classes.map((rc) => new SandboxWorkspaceExecutor({ resourceClass, backend, workspaces, pool }))`
(`:314`) and **no** `SyntheticExecutor`; the rung is `isolated: true`, `persistent: true` (`:317-318`),
cached per agent (`:292,295-297,339`), and `runTurn`'s `finally` calls `checkpoint()` instead of
`close()` for a persistent rung (`:416-419`). The synthetic rung (`:349-359`) builds only
`SyntheticExecutor` and is `isolated: false`.

`src/execution/kubernetes/sandbox-workspace.ts:46` `SandboxWorkspaceExecutor.canExecute` (`:70-77`)
accepts `workspace.read/write/list/delete` **and** `process.exec`; `execute` routes
read/write/delete/list through `#backend.readFile/writeFile/removePath` plus `#kind`/`#list`
(which issue `exec` into the pod, `:204-230`) and `process.exec` through `#backend.exec`
(`:120-139`). `MemoryWorkspace` is declared seed/checkpoint cache only (`:17-22,38`). So no executor
on the sandbox rung can serve a workspace effect from worker RAM: `KubernetesExecutor.canExecute`
returns false for anything but `process.exec` (`src/execution/kubernetes/executor.ts:40`) and
`SyntheticExecutor` is absent.

## 2. Failing-first — **SOLID**

- At `b4560c5^` (`b3f1ef6`) the module is absent: `git show b3f1ef6:…/sandbox-workspace.ts` fails;
  transplanting `test/sandbox-workspace.test.ts` into `b3f1ef6` fails the build with
  `TS2307: Cannot find module '../src/execution/kubernetes/sandbox-workspace.js'` (`v9-parent-build.log`).
- Behavioural red, through the **real** `defaultRungFactory({kind:"sandbox", namespace:"synth-audit-gvisor"})`
  at `b3f1ef6`: `workspace.write`/`workspace.read` are served by executor **`synthetic`**
  (`readBack: "parent-bytes"` from host RAM) while `process.exec` is `kubernetes:sandbox-small`.
  The parent rung is literally `[new SyntheticExecutor(workspaces), …KubernetesExecutor]` (git show).
- Green at `b4560c5`/`e19a573`, same probe: all three effects → executor
  **`sandbox-workspace:sandbox-small`**, `readBack: "pod-bytes"`.

Discriminating quantity is the broker-decorated `executor` id per effect kind, not a status.

## 3. Boundary attack (live gVisor) — **SOLID**

`integrations/kubernetes/sandbox-workspace-live.ts` against real k3s + gVisor (`v9-live-sandbox.log`):

| quantity | value |
|---|---|
| executor | `sandbox-workspace:sandbox-small` |
| `readBack` (pod) | `pod-bytes` |
| `list` | `["a.txt"]` |
| `execOutput` (`cat live/a.txt` in pod) | `pod-bytes` |
| cache before checkpoint | `undefined` (absent; the `ok` predicate requires it) |
| cache after checkpoint | `pod-bytes` |
| host sentinel | `host-untouched` |
| checkpoint digest / size | `sha256:77fffe5e5d6d785e1a4ca15a1f1879c52543c7f773d9a7e256a69a1c0beeba16` / 79 |
| pod observed | `synth-sandbox-small-071dbcf0` Pending→Running, `runtimeClassName=gvisor` |

Real rung through `defaultRungFactory` (`v9-rung-probe.log`): synthetic rung → `isolated:false`,
executor `synthetic`, `readBack:"host-bytes"`; sandbox rung → `isolated:true`, `persistent:true`,
write/read/exec all `sandbox-workspace:sandbox-small`, `execStdout:"pod-bytes"`, `execSandboxId`
`6898238e-…` matching the observed pod `synth-sandbox-small-6898238e` (gvisor). This is the local
control reversing.

Escape attack through the real sandbox rung (`v9-attack-probe.log`): `workspace.write` to
`../../tmp/opencode/orch/v9-escape-relative.txt` and to `/tmp/opencode/orch/v9-escape-absolute.txt`
both → `WORKSPACE_PATH_ESCAPES`; `workspace.read /etc/passwd` → `WORKSPACE_PATH_ESCAPES`;
`workspace.read v9-host-sentinel.txt` → `WORKSPACE_NOT_FOUND`; pod `cat` of the host sentinel path
→ `Command exited 1`; `hostEscapeFileCreated:false`; host sentinel still `host-untouched`. The pod's
filesystem is separate from the host repo/RAM.

## 4. Durability across activities — **SOLID, limitation stated**

Executed (`v9-persist-probe.log`): two calls to `defaultRungFactory` for the **same** agent return
the same rung object (`sameRungObject:true`), the same pod (`turn1ExecSandboxId === turn2ExecSandboxId
= b3d5ab59-…`), and turn 2 reads `turn1.txt` = `written-in-turn-1`; a **different** agent gets a
different pod and `WORKSPACE_NOT_FOUND:turn1.txt`. Cross-worker-restart durability is proved by the
unit test (`checkpointSandboxWorkspace` → blob digest → `restoreSandboxWorkspace` into a new pod) and
the deterministic live digest above. The limitation is stated, not overclaimed: `docs/KNOWN-OPEN.md:15-23`
(checkpoints are diffs; huge workspaces need the git transport) and `:61-70` ("`main` has no task
materialization/checkpoint layer … does not survive a worker restart").

## 5. Suite counts — **match**

`rm -rf dist` then build: root **198/198/0 skip** (`v9-root.log`), temporal **90/90/0**
(`v9-temporal.log`), syntax **82 TS / 0 diagnostics / 3 shell** (`v9-syntax.log`). README:166-174
states exactly these.

## Finding (LIKELY, doc/wiring): `assertRungAllowedForScored` is not wired

`gateway-run-turn.ts:111` exports `assertRungAllowedForScored(rung, scored)` and
`gateway-run-turn.test.ts:335-341` unit-tests it, but a whole-tree grep (excluding `dist/`, `test/`)
finds **only the definition** — no production caller. `runTurn` (`:379-442`) has no `scored`
parameter and never calls it. README:60-61 nonetheless says "a scored run refuses it
(`assertRungAllowedForScored`)"; a scored run on the synthetic rung is not actually refused by
`main`. `docs/KNOWN-OPEN.md:9-14` partly discloses this (the scored loop is on `gym-runner` and
"must call the refusal"), so it is a README overstatement plus an unwired guard, not a hidden hole.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v9-root.log`, `v9-temporal.log`, `v9-syntax.log`,
`v9-live-sandbox.log`, `v9-rung-probe.log`, `v9-attack-probe.log`, `v9-persist-probe.log`,
`v9-parent-probe.log`, `v9-pod-watch.log`, `v9-rung-pod-watch.log`, `v9-parent-build.log`,
`v9-head/integrations/temporal/v9-*-probe.mts` (throwaway, in removed worktrees).

---

# bar-audit — score against SPEC-super-harness

Full scorecard: `/tmp/opencode/orch/bar-scorecard.md`. Scored `main` `c89ec77` (not `e19a573`),
`gym-runner` `8c76f72` (unmerged). Reproduced at `c89ec77`: root **198/198**, temporal **90/90**,
syntax **82 TS / 0 diag / 3 shell**, opencode-http-gateway **3/3**, secret-scan clean; graph-restart
live proof green (`pre=1, iter=3, left=1, right=1, hang=2`, committed nodes not re-run);
durable-restart green (`committedCalls=1, hangCalls=2`); provider fake-server attack: config alone
switches provider (beta/alpha/default/env-form/fallback), no hardcoded key.

| # | item | verdict |
|---|---|---|
| 1 | unify under Temporal | **PARTIAL** — triage unified; gym unmerged and its loop is one `runTurn` activity (`GYM-ONE-TURN.md:45-59`) |
| 2 | stateful harness | **PARTIAL** — mailbox/graph/retries in Temporal; **effect receipts unwired** (`new ExecutionBroker` with no state at `gateway-run-turn.ts:315,354`) |
| 3 | graphs/loops | **PARTIAL** — live: loop/fan-out-join/SIGKILL restart; unit-only: branch/child/continue-as-new/cancel (docs say so) |
| 4 | providers direct | **MET** |
| 5 | even synth | **UNMET** — `assertRungAllowedForScored` has no caller; `README:60-61` overclaims |
| 6 | no hallucinations | **PARTIAL** — 7 docs fixed, dist pruned; new: README:60-61, receipt docs; stale: `LIVE-PROOF.md:10,24`, `LIVE-CONTRACTS.md:12,14`, Pi/external live claims |
| 7 | adversarial verification | **PARTIAL** — findings in `/tmp`, not repo; skip-only `live-proofs.mjs` exits 0; Temporal/k8s proofs not in CI |

Top gaps: (1) synthetic-rung refusal unwired + README overclaim; (2) effect receipts not persisted;
(3) gym unmerged + loop-in-activity; (4) verification not durable/continuous; (5) stale docs;
(6) graph child/continue-as-new/cancel unit-only; (7) root `dist/` still committed.

**Post-audit move (not audited).** Branches advanced during the audit: `main` → `fb66e53`
(`0d10baf "Wire the scored-rung refusal into runTurn"` — `assertRungAllowedForScored(rung,
config.scored === true)` now called at `gateway-run-turn.ts:393`; `fb66e53` supervisor-schedule
sweep) and `gym-runner` → `209967d` (`1b25b46` workspace.replace, `209967d "Gym: turn-per-activity —
the workflow owns the loop"`, `0dc96ec` docs). Items 1 and 5 therefore have in-flight fixes; the
verdicts above are for `c89ec77`/`8c76f72` and must be re-verified at the new HEAD (attack the
`scored:true` synthetic refusal and re-check README wording; re-measure the gym turn-per-activity
count).

**Repo untouched.** Artifacts: `/tmp/opencode/orch/ba-main-root.log`, `ba-main-temporal.log`,
`ba-main-syntax.log`, `ba-main-graph-restart.log`, `ba-main-durable-restart.log`,
`ba-attack.log`, `ba-calls.log`, `ba-opencode.log`, `ba-secret.log`, `bar-scorecard.md`.

---

# verify-10 — re-audit of guard-1 (`0d10baf`) and gym-3 (`1b25b46`, `209967d`, `0dc96ec`)

Scored `main` `fb66e53` (guard-1 in) and `gym-runner` `0dc96ec` (gym-3 in). Reproduced: main root
**198/198**, temporal **93/93**; gym temporal **86/86**. Worktrees `v10-main`, `v10-main-prev`
(`c89ec77`), `v10-gym`, `v10-gym-prev` (`8c76f72`), all removed. Nothing in the repo changed.

## Item 5 — scored-rung refusal — **MET** (was UNMET)

Executed attack on the real `runTurn` activity (`createGatewayRunTurn`, fake `fetchImpl`, no cluster;
`v10-guard-probe.mts`):

| case | fb66e53 (guard-1) | c89ec77 (before) |
|---|---|---|
| `scored:true` + `rung:{kind:"synthetic"}` | **refused**, `UNISOLATED_RUNG_REFUSED: a scored run requires an isolated (sandbox) rung`, `modelCalls=0` | **passed**, `modelCalls=1` |
| `scored:false` + synthetic (control) | passed, `modelCalls=1` | passed, `modelCalls=1` |
| synthetic, `scored` omitted (control) | passed, `modelCalls=1` | passed, `modelCalls=1` |
| `scored:true` + isolated rung (control) | passed, `modelCalls=1` | passed, `modelCalls=1` |
| `scored:true` + no rung (control) | passed, `modelCalls=1` | passed, `modelCalls=1` |

The refusal fires **before any model call** (`modelCalls=0`), and it is failing-first: red at
`c89ec77` (scored synthetic passed), green at `fb66e53`. `README.md:60-61` ("a scored run refuses it
(`assertRungAllowedForScored`)") now matches: the function is called at `gateway-run-turn.ts:391`
with `config.scored === true`, threaded via `DurableTurnConfig.scored` (`contracts.ts:80`).

**Caveat:** `scored` is opt-in and **no production caller sets it** (`git grep "scored: true"` on
both branches, excluding tests/dist, is empty). The triage worker is unscored; the gym guards its
scored runs with its own `GymUnisolatedScoredRun` refusal (`runner:"local"`, `gym-activities.ts:88,128,223`),
not this flag. So the guard is wired and correct, but "a scored run" only means a run a caller has
marked scored.

## Item 1 — gym turn-per-activity — **MET** (was PARTIAL)

Executed two-turn attempt through the real `gymAttemptWorkflow` + `gym-worker.ts` + a scripted
gateway + the real gVisor sandbox (`v10-multiturn.mjs`):

| commit | child workflow | turns | model HTTP | `runTurn` activities | gymPrepare | gymScore |
|---|---|---|---|---|---|---|
| `8c76f72` (before gym-3) | `durableAgentWorkflow` | 2 | 2 | **1** | 0 | 0 |
| `0dc96ec` (gym-3) | (none) | 2 | 2 | **2** | 1 | 1 |

Failing-first: `8c76f72` → `GAP: 2 turns ran inside 1 runTurn activity call(s)`; `0dc96ec` →
`IDEAL: one runTurn activity per turn`. The workflow now owns the loop
(`gym-workflows.ts:88 for (let turn = 0; turn < input.maxTurns; turn++)`, one `runTurn` proxy per
turn via `runTurnWithPark` at `:52`); `gymPrepareActivity` materializes once and `gymScoreActivity`
scores once. `outcome=passed`, `patchBytes` 358 in both, so the workspace survived across the two
activities (turn 2's `run_visible_test` passed on turn 1's edit). One-body invariant still holds:
the gym's turns build `createGatewayAgentEngine` (`src/gym/turn.ts:198`, `gym-activities.ts:164`) and
no gym file builds `/v1/chat/completions` or calls `fetch` (only a comment). Caveat: `gym-runner` is
still **not merged** into `main`.

## Item 2 — effect receipts — **UNMET** (unchanged)

Construction is still state-less in the shipped rung: `new ExecutionBroker(executors)` at
`gateway-run-turn.ts:315` (sandbox) and `:354` (synthetic); no `RuntimeStateStore` is passed. Only
the live driver `integrations/kubernetes/mixed-chain.ts:61` passes one. Executed demonstration
(`v10-receipts-probe.mts`, real `runTurn` activity, custom rung counting `executeEffect`): two
activity invocations with the same tool reply produce the **same effect id**
(`agt_receipt:write_thing:0`) and `executeEffect` runs **twice** (`executionsAcrossTwoActivityCalls=2,
deduped=false`). `buildToEffect` (`gateway-run-turn.ts:245`) makes ids stable across retries
(`${agentId}:${name}:${index}`), so a state store *would* dedupe — but none is wired, so an activity
retry re-executes the effect (harmless for an idempotent `workspace.write`, not for `process.exec`).
The docs are still unbacked: `docs/HARDENING.md:15` "receipt-backed", `docs/RECOVERY.md:17`
"persists a receipt", `docs/DISTRIBUTED.md:40`, `docs/TEMPORAL.md:43`.

## Item 7 (scorecard gap #7) — root `dist/` committed — **PARTIAL** (unchanged)

At `fb66e53`, root `dist/` is still tracked: **202** files; `integrations/*/dist/**` = **0**.
`gym-runner` `0dc96ec` tracks **238** root `dist/` files (gym-3 committed more). `c89ec77` pruned the
18 then-stale quarantined artifacts, but the mechanism remains: demonstrated that `tsc` does not
prune — created `src/v10-stale-probe.ts`, built (`dist/src/v10-stale-probe.js` appears), deleted the
source, rebuilt, and the compiled file **still exists**. `package.json` `test` is
`npm run build && node --test dist/test/*.test.js` with no `rm -rf dist`, so a deleted source test
can still be run from a stale compiled `dist/test/*.test.js` (the verify-7 defect).

## Scorecard item 7 (verification durability) — **PARTIAL** (unchanged)

The guard-1 and gym-3 fixes are committed with tests, but the adversarial proof that accepts them
(this audit) lives only in `/tmp`; `live-proofs.mjs` still exits **0** on a skip-only run; the
Temporal/k8s proofs are not in CI.

**Updated verdicts:** item 1 **MET**, item 2 **UNMET**, item 5 **MET** (opt-in caveat), item 7
(dist) **PARTIAL**.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v10-guard-main.log`, `v10-guard-prev.log`,
`v10-gym-multiturn.log`, `v10-gym-prev-multiturn.log`, `v10-receipts.log`, `v10-main-root.log`,
`v10-main-temporal.log`, `v10-gym-temporal.log`, `v10-multiturn.mjs`.

---

# premerge-audit — `gym-runner` → `main`

Full report: `/tmp/opencode/orch/premerge-report.md`. `main 6ccff43`, `gym-runner 0dc96ec`, merge-base
`ff7ab93`. Dry-run in a throwaway worktree, aborted and removed; repo untouched.

- **Turn body divergence.** `gym-runner` ported the body at `fec8c76` from a pre-`b3f1ef6` main. It
  lacks `provider-config.ts`, `sandbox-workspace.ts`, `worker-entry.ts`, `graph.ts`/`graph-workflow.ts`,
  and main's `gateway-run-turn.ts` features (`isolated/persistent/checkpoint`, `sandboxRungs`,
  `assertRungAllowedForScored`, `SandboxWorkspaceExecutor`); it uses the old
  `[SyntheticExecutor, KubernetesExecutor]` rung (workspace effects in worker RAM). It **has**
  `workspace.replace` + `spec.command`, which main lacks. Merge rule: main's runtime + graft gym's
  `workspace.replace`/`spec.command`.
- **Conflict map.** 20 unmerged files: 12 `dist/` (rebuild, never hand-resolve) + 8 source —
  `gateway-run-turn.ts` (main + gym replace), `contracts.ts` (union), `gateway-run-turn.test.ts`
  (union), `src/index.ts` (main's barrel + gym runner exports, **not** gym's deleted-module exports),
  `src/runtime/durable-turn.ts` (take main's deletion), `executor-image.ts`/`resource-class.ts`
  (comment-only, same pinned digest), `examples/kubernetes-demo.ts` (take main). The merge cleanly
  deletes the other quarantined modules and moves the stale docs to `docs/history/`.
- **One-body invariant holds on both branches** (only builder `gateway-engine.ts:142`; gym's
  `createGatewayGymTurn` is a thin adapter, no `fetch`).
- **Scorer divergence: none.** `src/gym/scoring.ts` is byte-identical on both (sqlite deny,
  `SYNTH_REQUIRE_ISOLATION`, symlink check) — take either.
- **Critical beyond-conflicts gaps:** (1) the gym's `integrations/gym/sandbox.ts` is a **second rung**
  (`SyntheticExecutor` workspace + `KubernetesExecutor` exec + `LocalRuntimeStateStore`), so its
  workspace effects run in host RAM — unify onto main's `SandboxWorkspaceExecutor`; (2)
  `SandboxWorkspaceExecutor` does **not** implement `workspace.replace`, so `replace_in_file` breaks
  once pointed at the runtime rung — add it; (3) receipts stay split (gym uses `LocalRuntimeStateStore`,
  the runtime rung none); (4) `src/artifacts/retention.ts` is a new gym module with no importer —
  wire or drop.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/premerge-conflicts.txt`, `premerge-merge.log`,
`premerge-merge2.log`, `premerge-report.md`.

---

# verify-rolling — newly landed on `main` (`6ccff43` → `46393a0`)

Landed since verify-10: **harness-2** (`459f3ad` graph child/CAN/cancel live proofs + a real
continue-as-new resume fix; `6ccff43` docs) and **receipts-1** (`85243a4` persist effect receipts in
the Temporal rung; `46393a0` docs). `legacy-1` landed as a claim removal (`fb66e53`). Not landed:
**merge-1** (gym unmerged), **hygiene-1**.

## harness-2 — **MET** (was PARTIAL)

Executed against Temporal `:7243` at `6ccff43` (`graph-*-live.ts`, `graph-restart-worker.ts`):

| proof | discriminating quantities | ok |
|---|---|---|
| `graph-child` | child type `runGraphWorkflow`, `childIsDistinctExecution=true`, started+completed events, order `pre,inner-a,activity:inner-b,after` | true |
| `graph-continue-as-new` | `runCount=2, continuesAsNew=1, iterActivityCalls=1100, iterCompletedNodes=1100, distinctIterationCounts=1100` | true |
| `graph-cancel` | `status=cancelled, countAtCancel=3, countAtReturn=3, counterStopped=true` | true |
| `graph-restart` | `pre=1, iter=3, left=1, right=1, hang=2`, committed nodes not re-run | true |

**Failing-first:** the new `graph-continue-as-new-live.ts` transplanted onto `fb66e53` (pre-fix)
times out (`exit 124`, empty log) — the old resume re-ran the whole graph and continued-as-new
forever. `docs/HARNESS.md` now lists all four proofs with the same numbers; README matches. Suites at
`6ccff43`: root **198/198**, temporal **94/94**.

## receipts-1 — **MET** (was UNMET)

Executed `effect-receipt-live.ts` at `46393a0`: real Temporal retry `attempts=[1,2]`,
`attempt1Seed=[]`, `attempt2Seed=["…:write_file:0:committed","…:write_file:1:started"]`,
`firstEffectExecutions=1` (`write_file:0` executed only on attempt 1), `ok=true`. **Failing-first:**
at `6ccff43` (pre-wiring) two activity calls with the same effect id execute twice
(`executionsAcrossTwoActivityCalls=2, deduped=false`); at `46393a0` the rung constructs
`new ExecutionBroker(executors, runtimeState)` (`gateway-run-turn.ts:330,370`) via the new
`TemporalActivityStateStore` (heartbeat details). Docs updated and accurate
(`README`/`HARDENING`/`RECOVERY`/`DISTRIBUTED`/`TEMPORAL`/`ARCHITECTURE`). Suites: root **198/198**,
temporal **97/97**.

## Other dispatched items

- **merge-1 — not landed.** `git merge-base --is-ancestor gym-runner HEAD` false (`gym-runner
  0dc96ec`).
- **legacy-1 — claim removed, not built.** `fb66e53` dropped the `ensureSupervisorSchedule` doc
  claim; `supervisor/schedule.ts` still has **no caller** (definitions only), and `KNOWN-OPEN.md:27`
  records it open. No unlabelled production loop found (the supervisor is a Temporal workflow).
- **hygiene-1 — not done.** A **skip-only** `live-proofs.mjs` exits **0** (`--only=openrouter-429,
  session-supervisor --json` → `{"skipped":2}`, `exit=0`; the aggregator is
  `process.exit(failures > 0 ? 1 : 0)`), violating standing order 6 (skip = exit 2). A deleted test
  source still leaves a stale compiled test: created `test/vr-stale.test.ts`, built, deleted the
  source, rebuilt → `dist/test/vr-stale.test.js` **still present**, and `npm test` runs
  `dist/test/*.test.js`. Root `dist/` is still tracked: **202** files.

**Updated scorecard:** item 2 **MET**, item 3 **MET**, item 5 **MET** (unchanged), item 1
**PARTIAL**, item 6 **PARTIAL (improved)**, item 7 **PARTIAL**, gap #7 (dist) **PARTIAL**.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/vr-graph-child-live.log`,
`vr-graph-continue-as-new-live.log`, `vr-graph-cancel-live.log`, `vr-graph-restart-worker.log`,
`vr-can-prev.log`, `vr-effect-receipt.log`, `vr-receipts-prev.log`, `vr-skiponly.log`,
`vr-main-root.log`, `vr-main-temporal.log`, `vr-receipts-root.log`, `vr-receipts-temporal.log`.

---

# verify-rolling (round 2) — `main 6e9581d` (hygiene-1 landed)

Newly landed since round 1 (`46393a0`): **hygiene-1** `e311f6a` (durable verification) + `6e9581d`
(clean dist before build / untrack root dist). `harness-2` and `receipts-1` unchanged (already MET).
`merge-1` and `legacy-1` not landed.

## hygiene-1 — **MET**

Executed at `6e9581d` (worktree `vroll2-main`):

- **Skip = exit 2.** `node scripts/live-proofs.mjs --only=openrouter-429,session-supervisor --json`
  → `{"skipped":2}`, **exit 2**; control `--only=effect-receipt` → **exit 0**. `live-proof.mjs` also
  exits 2 on SKIP. (`process.exit(failures>0?1:0)` replaced by `1` fail / `2` skip / `0` pass.)
- **CI runs the Temporal proofs.** `core.yml` temporal job installs `temporalio/setup-temporal@v0`,
  starts `temporal server start-dev --headless --port 7243`, waits for the port, and runs
  `live-proofs.mjs --only=graph-restart,durable-restart,graph-child,graph-continue-as-new,graph-cancel,effect-receipt`;
  a skip exits 2 and fails the job. (k8s `sandbox-workspace` still needs a gVisor cluster; not in CI.)
- **Findings in-repo.** `docs/VERIFICATION.md` (the standard + an attack→permanent-regression-test
  table) and `scripts/verify.mjs` (`npm run verify`).
- **Stale compiled test fixed.** `build` = `npm run clean && tsc` (`clean` = `rm -rf dist`). Created
  `test/vr2-stale.test.ts`, built (`dist/test/vr2-stale.test.js` appears), deleted the source,
  rebuilt → the compiled file is **gone**. Failing-first: at `46393a0` it survived (round-1
  `vr-stale-build2.log`).
- **Root `dist/` untracked.** `git ls-files 'dist/**'` = **0**; `.gitignore` has `/dist/` and
  `integrations/*/dist/`; `secret-scan` clean (466 index files) with dist untracked.
- **`npm run verify` → exit 0**: root suite, temporal suite, integration syntax, secret scan, and
  **6/6** live proofs passed (`durable-restart`, `graph-restart`, `graph-child`,
  `graph-continue-as-new`, `graph-cancel`, `effect-receipt`). Suites: root **198/198**, temporal
  **97/97**.

## Not landed

- **merge-1** — `gym-runner 0dc96ec` is not an ancestor of `main`.
- **legacy-1** — not built: `ensureSupervisorSchedule`/`triggerSupervisorSchedule` still have no
  production caller (definitions only); `KNOWN-OPEN.md:27` records it. The `fb66e53` sweep removed
  the doc claim rather than wiring the Schedule.

## Still open (unchanged)

- **Item 6 stale docs:** `docs/LIVE-PROOF.md:10` ("PASS process SIGKILL recovery"), `:24` ("16
  concurrent workers"), and `docs/LIVE-CONTRACTS.md:12,14` ("distributed control-plane contract",
  "real child-process SIGKILL recovery") remain at `6e9581d`.
- **Item 1:** gym unmerged (premerge-report.md has the reconciliation map).

**Updated scorecard:** item 7 **MET** (was PARTIAL), gap #7 root `dist/` **resolved**, item 6
**PARTIAL** (unchanged), items 2/3/5 **MET**, item 1 **PARTIAL**.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/vr2-skip.log`, `vr2-pass.log`,
`vr2-build1.log`, `vr2-build2.log`, `vr2-secret.log`, `vr2-verify.log`, `vr2-root.log`,
`vr2-temporal.log`.

---

# verify-rolling (round 3) — nothing new on `main`

`main` HEAD is unchanged at `6e9581d`; `git log 6e9581d..HEAD` is empty, so there is nothing new to
verify and no verdict changes (round 2's results stand: items 2/3/5/7 MET, item 6 PARTIAL, item 1
PARTIAL, gap #7 resolved).

Observed but **not on `main`**: `merge-1` is in flight — a `merge-1` branch and worktree
(`/tmp/opencode/orch/merge1`, left untouched) are mid-merge at `6e9581d` with the gym files staged
and uncommitted, and `gym-runner` advanced from `0dc96ec` to `fddaf87` ("Gym durable turn: two real
bugs the first real-model run exposed"). The next round should re-run the premerge report's
acceptance set once the merge commits: one-body grep, two-arm sandbox attempt
(`runTurnActivities === turns`, executor `sandbox-workspace:sandbox-small`), boundary/escape test,
graph-restart, and `npm run verify`.

**Repo untouched.** No worktree created this round.

---

# verify-rolling (round 4) — `main 9fad1dd` (merge-1 landed)

`main` moved from `6e9581d` to **`9fad1dd`**: two merge commits, `47ac0e1` (gym-runner `0dc96ec`)
and `9fad1dd` (gym-runner `fddaf87`). `gym-runner fddaf87` is now an ancestor of `main` — **the gym
is merged**. Executed in a worktree at `47ac0e1` then `9fad1dd`.

## merge-1 — **landed, with the premerge gaps open**

**Green (executed):**

- **Gym merged, one turn body.** Only `src/runtime/gateway-engine.ts:142` builds
  `/v1/chat/completions`; the gym builds `createGatewayAgentEngine` (`gym-activities.ts:164`,
  `src/gym/turn.ts`), no gym `fetch`.
- **Suites:** root **276** tests / 274 pass / 0 fail / **2 skipped** (the two live gVisor tests,
  `SYNTH_LIVE_GVISOR=1`); temporal **103/103**.
- **Two-arm sandbox attempt** through the real `gymAttemptWorkflow` + gVisor: `childWorkflow=(none)`,
  `turns=2`, `runTurnActivities=2`, `gymPrepare=1`, `gymScore=1`, `outcome=passed` — turn-per-activity
  holds.
- **Live gVisor boundary tests** (`SYNTH_LIVE_GVISOR=1`, pinned image, ns `synth-audit-gvisor`):
  **3/3** — "a sandbox attempt runs the tools in the pod and scores the golden fix", "the boundary
  contract rejects a local run", "the gVisor pod cannot see the host, the vectors, or reach host TCP".
- **fddaf87 fixes present:** `turnScopedEffectId(turn, attempt, id)` = `t${turn}:a${attempt}:${id}`
  (`gym-activities.ts:75,216`).
- **Conflict union correct:** `workspace.replace` present in `types.ts`/`synthetic.ts`/`contracts.ts`/
  `gateway-run-turn.ts`; `scored`, `oldTextArg`/`newTextArg`, `command` present; `src/runtime/durable-turn.ts`
  absent; `src/index.ts` does not export the deleted modules.

**Open (executed rung probe at `9fad1dd`) — the premerge report's two critical items:**

```
gymRunner:   writeExecutor="synthetic"  replaceExecutor="synthetic"  (host RAM)
runtimeRung: writeExecutor="sandbox-workspace:sandbox-small"
             replaceOk=false  replaceError="No executor can satisfy effect"
```

1. The gym's **parallel host-RAM rung survives**: `integrations/gym/sandbox.ts:169-171` is still
   `new ExecutionBroker([new SyntheticExecutor, new KubernetesExecutor], new LocalRuntimeStateStore())`;
   `buildSandboxRunner`'s `executeEffect` serves `workspace.write`/`workspace.replace` with executor
   `synthetic` (worker RAM), not the pod. Only `process.exec` reaches the pod.
2. **`SandboxWorkspaceExecutor` cannot `workspace.replace`** (`WORKSPACE_EFFECTS` at
   `sandbox-workspace.ts:12` is `{read,write,list,delete}`); the runtime rung returns "No executor can
   satisfy effect". Pointing the gym's `replace_in_file` at the runtime rung (the intended
   unification) would break it.

So the merge is mechanically clean and its scripted/gVisor tests pass, but the two runners are not
unified and the pod executor lacks the gym's read-modify-write effect.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/vr3-build.log`, `vr3-root.log`, `vr3-temporal.log`,
`vr3-multiturn.log`, `vr3-gvisor.log`, `vr3-rung.log`, `vr3b-build.log`, `vr3b-root.log`,
`vr3b-temporal.log`, `vr3b-multiturn.log`, `vr3b-gvisor.log`, `vr3b-rung.log`.

---

# verify-ext — external review (`ff8d170`, `82de784`, `0770895`) + the overnight merge

`main` = `0770895` (the three review commits are on it). Verified in a worktree at `0770895`
(`rm -rf dist`, Node 22). Overall **SOLID**, with one **LIKELY** finding: the review's own doc edit
introduced a new unbacked claim.

## 1. `ff8d170` dead code — **SOLID**

- `git grep -E "InMemoryTraceSink|JsonlTraceSink|observability/trace"` over `src integrations scripts
  test examples` (excluding `docs/history`, `dist`) → **zero**.
- `src/observability/otel.ts` is the live tracing: `withSpan` is imported and used by
  `src/execution/broker.ts`, `src/execution/kubernetes/kubectl-backend.ts`,
  `src/runtime/gateway-engine.ts`; `activity-interceptors.ts` references it in a comment.
- `chaos:matrix` removed: no entry in `package.json`, `scripts/chaos-matrix.mjs` absent; the only
  remaining mention is `docs/EXECUTION-PATHS.md:78`, in the Dead/removed list.
- The quarantine removed nothing load-bearing: build (`tsc`) **green**, root **276** (274 pass, 0
  fail, 2 skip), temporal **104/104**.

## 2. `82de784` + `0770895` docs vs reality — **LIKELY (one new unbacked claim)**

Numbers reproduced exactly at `0770895`:

| suite | reported | measured |
|---|---|---|
| root | 276 (274 pass / 2 skip) | **276 / 274 / 0 fail / 2 skip** |
| temporal | 104 | **104/104** |
| `integrations:syntax` | 101 TS / 0 diag / 3 shell | **101 / 0 / 3** |
| opencode-http-gateway | 3 | **3/3** |
| secret-scan | clean (509) | **clean (509 index files)** |

Removed claims confirmed gone: "Local in-memory and JSON-file providers retain monotonic fenced
generations" → replaced (`README.md:94`); "shared rate limiting … verified live" → gone
(`RELEASE-GATE.md:45` now "tested against a fake `PgExecutor`"); the effect-receipts-in-Postgres
diagram → `README.md:143` ("effect receipts in Temporal state (or DB)") and `ARCHITECTURE.md:38`
("effect receipts: Temporal activity state, or here"); `LIVE-PROOF.md` sample now matches
`scripts/live-proof.mjs`'s labels (`PASS Temporal integration suite`, `SKIP Temporal worker-restart
proof — temporal 127.0.0.1:7243 not reachable`) with no "process SIGKILL recovery" and 32-vs-16
disclosed; `LIVE-CONTRACTS.md` "Always runnable" now lists only commands that exist.

**Attack on the review — new unbacked claim.** `README.md:94` (added by `82de784`) says the
monotonic fenced-generation behaviour is "tested in `test/postgres-control.test.ts` **against the
real database clock**". That test uses a **fake** `RecordingPg implements PgExecutor` (fixed rows,
a stub `db_clock.now_ms`); it asserts the SQL text contains `clock_timestamp()` and never receives a
worker timestamp — it does not run against a real database. `grep` for a real PG import / `Pool` /
`SYNTH_POSTGRES_URL` in that file is empty. So the review corrected one "verified live" overclaim and
introduced a milder one in the same class: a store property attributed to a real DB clock when the
proof is a SQL-shape test against a fake. Fix: say "asserts the SQL uses `clock_timestamp()` and
takes no worker time (against a fake `PgExecutor`); the real clock is exercised by the live
concurrency proof." (Pre-existing, not introduced by these edits: `RELEASE-GATE.md:40` claims the
distributed stores were proven "32-256 concurrent workers"; `concurrency.ts` only reads
`SYNTH_POSTGRES_WORKERS` (default 16, CI 32) and no 256-worker run is recorded — `cdc2a36`.)

## 3. The overnight merge — **SOLID**

- `9fad1dd` (and `47ac0e1`) are ancestors of `main`; `gym-runner` was merged at `fddaf87`. Note
  `gym-runner` has since advanced to `4fa32fc` (FORGE 5b + attack consolidation), which is **not** in
  `main`.
- One turn body: the only `/v1/chat/completions` builder is `src/runtime/gateway-engine.ts:143`; no
  `fetch(`/`doFetch` in `src/gym/turn.ts` (the gym's `createGatewayGymTurn` is a thin adapter over
  `createGatewayAgentEngine`).
- Pinned executor unchanged:
  `ghcr.io/taituo/synth-executor@sha256:fc59cec2b7a3733e9e50db1d5063669c60ec7add0d18a338b2a3f19a422c822f`.
- Hardened scorer present: `--no-experimental-sqlite` deny, `SYNTH_REQUIRE_ISOLATION === "1"`
  refusal, and the `realpath` symlink-escape check (`src/gym/scoring.ts:255,317,326,368,397`).
- Suites at `0770895`: root **276/274/0/2 skip**, temporal **104/104**.
- The review's rewritten `docs/KNOWN-OPEN.md` matches my independent finding: the gym's own broker
  serves `workspace.read/write/replace` from the `SyntheticExecutor` (worker RAM), and
  `SandboxWorkspaceExecutor` does not implement `workspace.replace`.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v5-build.log`, `v5-root.log`, `v5-temporal.log`,
`v5-syntax.log`, `v5-oc.log`, `v5-secret.log`.

---

# verify-isolation — scoring worker in the gVisor pod (`0a6b2fa` + `4762e94`)

`main` = `4762e94`. Verified in worktrees `v6-main` (`4762e94`) and `v6-prev` (`0770895` = `0a6b2fa^`),
built with `rm -rf dist`. Node 22, k3s `gvisor`, pinned image `sha256:fc59cec2…`. **SOLID.**

## 1. Call path — verified

- `isolatedScoreGymPatch` (`src/gym/scoring.ts:408-419`) selects the pod via
  `sandboxScorerConfig()` (env `SYNTH_EXECUTOR_IMAGE`, or injected `IsolatedScoreOptions.sandbox`);
  `SYNTH_REQUIRE_ISOLATION=1` with no boundary returns `errored`
  ("no OS-level sandbox is configured; refusing to run agent code in an untrusted context") — executed.
- `scoreInSandbox` (`src/gym/sandbox-worker.ts:106-172`) creates the one-shot pod,
  `materializeClone` skips `.git`/`node_modules` (`:73-89`), writes `worker.mjs` + `requests.json`
  (`:121-128`); the requests carry **module/call/args only** (`:121-126`), never an expected value.
  The exec is `node worker.mjs requests.json results.json` (`:132-135`); `results.json` is read and
  compared to `testCase.expect` back on the trusted side (`:149-163`); the pod is destroyed (`:170`).
  So the held-out cases stay in verifier memory and never enter the pod.

## 2. Probe before/after — verified, and attacked beyond localhost

`scripts/scorer-isolation-probe.mjs` at `4762e94`:

| class | pod (`SYNTH_EXECUTOR_IMAGE`) | host control (`SYNTH_SCORER_SANDBOX=0`) |
|---|---|---|
| node:sqlite host DB | BLOCKED (`ERR_SQLITE_ERROR`) | BLOCKED (`ERR_UNKNOWN_BUILTIN_MODULE`) |
| tcp temporal `:7243` | BLOCKED (`ECONNREFUSED`) | **REACHABLE** (`CONNECTED`) |
| tcp postgres `:5432` | BLOCKED (`ECONNREFUSED`) | BLOCKED (`ECONNREFUSED`, no local service) |
| unix socket at host path | BLOCKED (`EACCES`) | **REACHABLE** (`BOUND:…/escape-….sock`) |
| signal verifier PID | BLOCKED (`ESRCH`) | **REACHABLE** (`CAN-SIGNAL-VERIFIER`) |
| `os.userInfo` host metadata | BLOCKED (`synth:65532`) | **REACHABLE** (`tiny:1000`) |
| exit | **0** | **2** |

Because the probe's TCP rows only try `127.0.0.1` (pod-local), I ran an extra egress attack from the
pod (`v6-egress-probe.mjs`): Postgres ClusterIP `10.43.101.77:5432`, node IP `10.91.1.1:7243`, node
IP `10.91.1.1:22`, and public `1.1.1.1:443` all **`ECONNREFUSED`** from inside the pod. The boundary
holds beyond loopback, not just for pod-local ports.

## 3. Failing-first — verified

- `0770895` (`0a6b2fa^`), `SYNTH_EXECUTOR_IMAGE` set: the worker still ran on the host — **4 REACHABLE**
  (temporal TCP, unix socket, verify signal, `tiny:1000`) + 1 UNCONFIRMED, **exit 2** (red).
- `0a6b2fa`: all six BLOCKED, **exit 0** (green).

## 4. Control still passes — verified through the pod

`test/gym-real-task.test.js` (real `he` fixture) with the pod env: **3/3** — "bugged tree failed" /
"golden fix passed", the fixture contract, and the scoring matrix (golden passed, partial fix failed).
A pod watcher during the run observed `synth-sandbox-small-*` pods with `runtimeClassName=gvisor`, so
the golden/wrong control executed in the gVisor pod, not on the host. Suites at `4762e94`: root
**277** (275 pass, 0 fail, 2 skip), temporal **104/104**.

## 5. Disclosed limit — stated and true at HEAD

`docs/SCORER-SANDBOX.md` ("One boundary, both execution paths") and `docs/KNOWN-OPEN.md:14-22,91-104`
state the remaining gap. Confirmed true: `integrations/gym/sandbox.ts:169-171` still builds
`ExecutionBroker([SyntheticExecutor, KubernetesExecutor], LocalRuntimeStateStore())`, and
`SandboxWorkspaceExecutor`'s `WORKSPACE_EFFECTS` (`sandbox-workspace.ts:12`) has no `workspace.replace`.
One looseness: SCORER-SANDBOX says "the gym's `runner:"sandbox"` arm drives the pod" — true for
`process.exec`, but `workspace.*` runs in worker RAM; `KNOWN-OPEN.md:14-17` states that precisely.

## Minor findings (do not undermine the claim)

- **Probe boundary label is wrong under `SYNTH_SCORER_SANDBOX=0`**: it prints
  `boundary: pod (gVisor)` because it keys off `SYNTH_EXECUTOR_IMAGE` presence, not the actual
  selection; the row statuses are still correct. Cosmetic, but a CI log reader could be misled.
- **Probe exits 0 on `unconfirmed`**: `process.exit(rows.some(reachable) ? 2 : 0)`; only `reachable`
  is fatal. An unrecognized result would pass. Suggest `unconfirmed` also exit 2.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v6-probe-pod.log`, `v6-probe-host.log`,
`v6-probe-prev.log`, `v6-egress.log`, `v6-real-task-pod.log`, `v6-real-task-pod2.log`,
`v6-pod-watch.log`, `v6-root.log`, `v6-temporal.log`.

---

# verify-gym5 — one rung, gym workspace in the Pod (`gym-runner a6fb152`)

Verified in worktrees `v7-gym` (`a6fb152`) and `v7-gym-prev` (`4fa32fc` = `a6fb152^`), built with
`rm -rf dist`. Node 22, k3s `gvisor`, pinned image `sha256:fc59cec2…`. **SOLID.**

## 1. Call path — verified

- `integrations/gym/sandbox.ts:176-177` now builds `new SandboxWorkspaceExecutor({ resourceClass,
  backend, workspaces })` and `new ExecutionBroker([executor], new LocalRuntimeStateStore())` — **no
  `SyntheticExecutor`**. `:203-205` `close()` calls `executor.close()` (destroys the pod).
- `src/execution/kubernetes/sandbox-workspace.ts:12` `WORKSPACE_EFFECTS` now includes
  `workspace.replace`; the case at `:106-118` does a read-modify-write **in the pod**
  (exactly-one-match, error otherwise).
- `integrations/temporal/src/gateway-run-turn.ts:319-320` (runtime sandbox rung) is now
  `SandboxWorkspaceExecutor` only; `:354` `SyntheticExecutor` remains only on the labelled synthetic
  rung (`defaultRungFactory` `kind:"synthetic"`). The commit also fixes `brokerEffectRunner.read`
  (`String(Uint8Array)` was comma-joining bytes).

## 2. Boundary — real-pod probe (executed)

Probe through the **real** `buildSandboxRunner` + `KubectlSandboxBackend` (ns `synth-audit-gvisor`):

| quantity | `a6fb152` | `4fa32fc` (before) |
|---|---|---|
| `workspace.write` executor | **`sandbox-workspace:sandbox-small`** | `synthetic` |
| `workspace.replace` executor | **`sandbox-workspace:sandbox-small`** | `synthetic` |
| replace read-back | `x = parseInt(hexDigits, 16);\n` (text) | `120,32,61,…` (comma-joined bytes) |
| `process.exec` executor | `sandbox-workspace:sandbox-small` | `kubernetes:sandbox-small` |
| pod id | `f9eb96a1-…` = observed pod `synth-sandbox-small-f9eb96a1` (gvisor) | — |
| host checkout | unchanged (`hexDigits, 10`) | unchanged |
| host sentinel | `host-untouched` | `host-untouched` |

So before, workspace effects ran in worker RAM (`synthetic`) and only `process.exec` reached the pod;
after, **every** effect runs in the pod. The pod watcher captured the real gVisor pod.

## 3. One rung — verified

Grep: the only `ExecutionBroker([SyntheticExecutor, KubernetesExecutor])` on the sandbox path is
gone; `gym/sandbox.ts` has `ExecutionBroker([SandboxWorkspaceExecutor])` and the runtime sandbox rung
`ExecutionBroker([SandboxWorkspaceExecutor…])`. `workspace.replace` actually edits in the pod — the
live test "workspace.replace runs in the pod: the edit lands, host RAM is not the medium" passes, and
a later read sees the edit (probe + test). The unit test `gym-sandbox-rung.test.ts` asserts
`executor === "sandbox-workspace:sandbox-small"` and `notEqual "synthetic"`; **failing-first**:
transplanted onto `4fa32fc` it fails ("workspace effects must run on the pod executor", and the
`backend` test seam does not even typecheck there).

## 4. Control — verified

Scripted durable sandbox attempt (Temporal `:7243`, gVisor): `outcome=passed`, `patchBytes=358`,
`isolation=gvisor`, `turns=2`, `runTurnActivities=2`, `gymPrepare=1`, `gymScore=1`,
`childWorkflow=(none)`. Live gVisor suite **7/7** (incl. "a sandbox attempt … golden fix passed",
"the boundary contract rejects a local run", "the gVisor pod cannot see the host, the vectors, or
reach host TCP"). The `local` control arm stays labelled (`src/gym/runner.ts:38` `isolated:false`,
`scoredAllowed:false`) and refused for scored runs (`GymUnisolatedScoredRun` at
`gym-activities.ts:136,176,278`; temporal tests 26-28 pass).

## 5. Counts + one-body invariant — verified

Root **297** (295 pass, 0 fail, 2 skipped live-gVisor), temporal **88/88**. One turn body holds: the
only `/v1/chat/completions` builder is `src/runtime/gateway-engine.ts:142`; `createGatewayGymTurn`
(`src/gym/turn.ts:198`) is a thin adapter over `createGatewayAgentEngine`, no `fetch`.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v7-gym-root.log`, `v7-gym-temporal.log`,
`v7-gym-rung-test.log`, `v7-prev-rung-test.log`, `v7-probe-main.log`, `v7-probe-prev.log`,
`v7-pod-watch.log`, `v7-multiturn.log`, `v7-multiturn2.log`, `v7-gvisor-tests.log`.

---

# verify-rolling (round 5) — `main 2cbb23e` (SQL-shape/clock docs) + legacy-1 check

`main` moved `4762e94 → 2cbb23e`; the only new commit is **`2cbb23e`** ("Docs: label the Postgres
SQL-shape proofs against the live clock proof"), a direct follow-up to the verify-ext finding.
Verified in a worktree at `2cbb23e`. `gym-runner` is still `a6fb152` (verified in verify-gym5),
`telemetry-1` is dispatched but not landed.

## `2cbb23e` — **SOLID** (my verify-ext findings are fixed)

- **README:94 fixed.** No longer "tested … against the real database clock". It now says the test is
  "a SQL-shape test against a fake `PgExecutor` … asserts the statements use `clock_timestamp()` and
  take no worker-supplied time. The real database clock (and worker clock skew) is exercised by the
  live concurrency proof in `integrations/postgres/concurrency.ts`." That is exactly the correction;
  `docs/ARCHITECTURE.md:180` matches.
- **The 256-worker overclaim is dropped/labelled.** `docs/RELEASE-GATE.md:42-43` now says the
  recorded run used 16 (CI 32), "not at the 256-worker scale a historical benchmark claims";
  `docs/POSTGRES.md:44-51` labels the 256-way benchmark "not reproducible here" and points at the
  repeatable 16/32 proof. The `256-way` figure is gone from the `test/postgres.test.ts` comment.
- **Numbers reproduced at `2cbb23e`:** root **277** (275 pass, 0 fail, 2 live-gVisor skips), temporal
  **104/104**, `integrations:syntax` **101 TS / 0 diag / 3 shell** — matches the commit.

## legacy-1 (`236a649`) — **SOLID**, bonus check

The hand-run supervisor is now a Temporal Schedule: `supervisor/supervise.ts`
(`npm run supervisor:supervise`) registers a session with `ensureSupervisorSchedule` and starts it
with `triggerSupervisorSchedule`; `supervisor/live.ts` starts it **only** through the Schedule. Ran
the live proof against the separate Temporal `127.0.0.1:7244` + tmux (both up):
`schedule.created=true`, `scheduleFired=true`, `blocked.escalations=1`, `redirect.delivered=true`,
`restart.survived=true`, `scheduleRecreated=true`, **`ok:true`, exit 0** on the re-run. The
KNOWN-OPEN "Schedule helper is unwired" item is closed. No unlabelled production loop:
`supervisor/workflows.ts:63` is a workflow-deterministic loop; the `while`/`sleep` in `live.ts`/
`probe.ts` are proof scripts.

**Minor flake:** the **first** run of the supervisor live proof returned `ok:false` because the
`working.status` sample was `"idle"` instead of `"working"`/`"blocked"` (all other quantities held);
an immediate re-run sampled `"working"` and passed. Looks like a sample-timing race in the proof, not
a functional defect, but it makes the proof non-deterministic.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v8r-root.log`, `v8r-temporal.log`, `v8r-syntax.log`,
`v8r-supervisor.log`, `v8r-supervisor2.log`.

---

# verify-merge2 — merged `main e2c6ba8` (gym-runner `a6fb152` on `2cbb23e`)

`e2c6ba8` = merge of `2cbb23e` (main) and `a6fb152` (gym-runner). Verified in a fresh worktree at
`e2c6ba8` with `rm -rf dist` + rebuild, Node 22, k3s `gvisor`, pinned image `sha256:fc59cec2…`.
Overall **SOLID**, with one **LIKELY** stale-doc finding introduced by the merge.

## 1. No regression — verified

Root **271** (269 pass, 0 fail, 2 skipped live-gVisor), temporal **104/104**,
`integrations:syntax` **101 TS / 0 diag / 3 shell**. (Root is 6 lower than the pre-merge 277 because
the gym branch consolidated its tests — `gym-vacuity.test.ts` → `gym-forge.test.ts`, and
`gym-isolated-score.test.ts` trimmed ~193 lines — not lost coverage.)

## 2. One rung on `main` — verified (failing-first)

- `e2c6ba8` `integrations/gym/sandbox.ts:176-177`: `new SandboxWorkspaceExecutor({...})` +
  `new ExecutionBroker([executor], new LocalRuntimeStateStore())` — no `SyntheticExecutor`.
- **Failing-first** at `2cbb23e`: `integrations/gym/sandbox.ts:169-171`
  `new SyntheticExecutor` + `new KubernetesExecutor` + `ExecutionBroker([synthetic, real], …)`.
- Real-pod probe through the **merged** `buildSandboxRunner`: `workspace.write`,
  `workspace.replace` and `process.exec` all execute on executor **`sandbox-workspace:sandbox-small`**;
  replace read-back is the edited text; host checkout unchanged; host sentinel `host-untouched`; pod
  `synth-sandbox-small-33614483` (`gvisor`).
- Runtime sandbox rung `gateway-run-turn.ts:354-355` is `SandboxWorkspaceExecutor`; synthetic only on
  the labelled synthetic rung (`:395`).

## 3. One turn body + pinned image + hardened scorer — verified

Only `src/runtime/gateway-engine.ts:143` builds `/v1/chat/completions`. `EXECUTOR_IMAGE =
ghcr.io/taituo/synth-executor@sha256:fc59cec2…`. `src/gym/scoring.ts` still has the sqlite deny, the
`SYNTH_REQUIRE_ISOLATION` refusal and the `realpath` symlink check.

## 4. Runtime paths survived the merge — verified (spot-checked)

| path | evidence on `e2c6ba8` |
|---|---|
| triage turn | `worker-entry.ts:48` `runTurn: createGatewayRunTurn(resolveProvider())` |
| graph harness | `graph.ts` + `graph-workflow.ts` present; `graph-restart-worker.ts`, `graph-child-live.ts`, `graph-continue-as-new-live.ts`, `graph-cancel-live.ts` present |
| effect receipts | `receipt-store.ts` present; `gateway-run-turn.ts:15` imports `TemporalActivityStateStore`; `runtimeState` threaded into the rung |
| supervisor Schedule | `supervisor/supervise.ts:63,66` calls `ensureSupervisorSchedule`/`triggerSupervisorSchedule` |
| telemetry | `src/execution/broker.ts:2` imports `withSpan` (OTel spans on effect execution) |

## 5. Disclosed state — verified

The scoring worker runs in the pod (`src/gym/sandbox-worker.ts`); the gym's agent tool path is now the
runtime rung in the pod (`KNOWN-OPEN.md:10-15`). Remaining isolation gaps, all stated: the synthetic
rung is unisolated by design; the gym's `localEffectRunner` is a labelled control refused for scored
runs; and `assertRungAllowedForScored` is opt-in with **no production caller that sets `scored`**
(the gym uses its own `GymUnisolatedScoredRun`). So the remaining gap is the shared scored flag, not
a hidden host-RAM medium.

## Finding (LIKELY, stale doc from the merge)

`docs/SCORER-SANDBOX.md:55-59` on merged `main` still says: "The remaining work is to route the agent's
tool execution through the runtime's sandbox rung too (the rung's `SandboxWorkspaceExecutor` does not
yet support `workspace.replace`, which the gym tools use)". Both halves are now false — gym-5 made the
gym's sandbox arm the runtime rung and added `workspace.replace` — and it directly contradicts the
updated `docs/KNOWN-OPEN.md:10-15`. `SCORER-SANDBOX.md` lives only on `main` (not on `a6fb152`), so the
merge owner updated KNOWN-OPEN but not this file. Fix: delete the paragraph or state that the tool
path is now in the pod and only the shared `scored` flag remains.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v9m-build.log`, `v9m-root.log`, `v9m-temporal.log`,
`v9m-syntax.log`, `v9m-probe.log`, `v9m-pod-watch.log`, `v9m-multiturn.log`, `v9m-gvisor.log`.

---

# verify-gym6 — channel sweep / parent-secret leak closed (`gym-runner 5e0b308`)

Verified in worktrees `v10g-gym` (`5e0b308`) and `v10g-prev` (`a6fb152` = `5e0b308^`), `rm -rf dist`
+ rebuild. **SOLID.**

## 1. Env leak — closed (failing-first)

`WORKER_ENV_ALLOWLIST` (`src/gym/scoring.ts:291-310`) + `workerEnvironment()` replace the old
`{ ...process.env }` (minus `GYM_HIDDEN_*`/`NODE_TEST_CONTEXT`). Standalone probe plants four names
and has the **real worker** report which it can see:

| commit | worker saw | outcome |
|---|---|---|
| `a6fb152` (before) | `open:SYNTH_GATEWAY_API_KEY,MY_API_TOKEN` | **failed** |
| `5e0b308` (after) | `denied` (none visible) | **passed** |

So the gateway/OpenRouter/generic secrets no longer reach agent code (the `GYM_HIDDEN_*` and
`NODE_TEST_CONTEXT` names were already stripped before).

## 2. The tests can fail (executed, guard broken → red → restored)

Each break was made in the worktree, `npm run build`, the test run, then `git checkout -- src/gym/scoring.ts`
and rebuilt.

| guard broken | result |
|---|---|
| `workerEnvironment()` → `{ ...process.env }` | **env red**, control green (exit 1) |
| `workerArgs(node, work)` → `[]` (no `--permission`/sqlite deny) | **fs + builtins + child/write red**, env/symlink/control green |
| `findEscapingSymlink` → `return undefined` | **symlink red + `FORGE 6` red**, env/control green |

All three go red **for the right reason** (the channel probe returns `open:…` / the score is not
`tampered`), and the control + unrelated channels stay green.

## 3. Golden control — verified

`CHANNELS control` asserts the golden fix `passed` and a wrong fix `failed`; it stayed green through
every break above, and `gym-forge-channels` is **6/6** on the committed tree.

## 4. Open list — stated and true

`docs/KNOWN-OPEN.md:14-62` lists network/DNS/UDP/unix sockets, `node:test` `run({files})`,
`process.kill(ppid)`, host metadata and `realpathSync` metadata as **open**, each with probe evidence,
and states plainly that "The boundary for a *scored production run* is the gVisor pod
(`test/gym-sandbox-boundary.test.ts`, live), not this host worker" and that none currently yields
ground truth. This matches my verify-isolation measurements (host worker: TCP reachable, socket bound,
verifier signalled, host userInfo) and the pod measurements (all blocked).

## Suite

Root **303** (301 pass, 0 fail, 2 skipped live-gVisor) with the integration `tsx` installed and the
fixture cache present — matches the commit. (Without the integration deps the same run is 296 pass /
7 skip, all `tsx not installed` — environmental, not a regression.)

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v10g-envleak-prev.log`, `v10g-envleak-main.log`,
`v10g-channels.log`, `v10g-break1.log`, `v10g-break2.log`, `v10g-break3.log`, `v10g-root3.log`.

---

# verify-rolling (round 6) — `main 67dc11f` (fixes for my round-5 findings)

`main` moved `e2c6ba8 → 67dc11f` ("Fixes: deterministic supervisor proof, honest isolation-probe
labels"). Verified in a worktree at `67dc11f` (`rm -rf dist`, rebuild). **SOLID** — both findings I
raised are fixed.

- **Supervisor proof is deterministic.** `integrations/temporal/supervisor/live.ts` now waits (bounded
  25 s) for the `working` status and the `blocked`+escalation transition instead of sampling the
  first check-in. Ran the live proof **3×** against Temporal `127.0.0.1:7244` + tmux → **3/3 `ok:true`,
  `working.status="working"`** every run, with `blocked.status="blocked"`,
  `escalations=1`, `redirect.delivered=true`, `restart.survived=true`, `scheduleRecreated=true`.
  The round-5 flake (`working.status="idle"` → `ok:false`) no longer occurs.
- **Isolation probe is honest.** The label now comes from `sandboxScorerConfig()`, and `unconfirmed`
  exits 2:
  - pod path (`SYNTH_EXECUTOR_IMAGE`) → **exit 0**, `boundary: pod (gVisor)`;
  - host path (`SYNTH_SCORER_SANDBOX=0` with the image still set) → **exit 2**,
    `boundary: host (Node permission model)` (previously mislabelled `pod`);
  - unconfirmed (`SYNTH_REQUIRE_ISOLATION=1`, no image) → rows `UNCONFIRMED`, **exit 2**.
- **Suites:** root **271** (269 pass, 0 fail, 2 live-gVisor skips), temporal **104/104**,
  `integrations:syntax` **101/0/3**.
- `gym-runner` is still `5e0b308` (verified in verify-gym6, not on `main`); `telemetry-1` has no
  distinct new commit since `67dc11f` (the observability work landed earlier in `2f18b9c`/`4ba859b`/`9c622cf`).

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v11-root.log`, `v11-temporal.log`, `v11-syntax.log`,
`v11-probe-pod.log`, `v11-probe-host.log`, `v11-probe-unconf.log`, `v11-supervisor-1..3.log`.

---

# verify-scored — shared scored-rung guard applied (`main dcc77b4`)

Verified in worktrees `v12-main` (`dcc77b4`) and `v12-prev` (`67dc11f` = `dcc77b4^`), `rm -rf dist`
+ rebuild. **SOLID**, with one minor LIKELY note (a residual driver-level predicate).

## 1. Call path — verified

- `integrations/temporal/src/contracts.ts` + `gym-contracts.ts:31` add `GymAttemptActivityInput.scored`
  (default true). `run-gym.ts:310` and `p2-faults.ts:161` set `scored: true` explicitly.
- `gym-activities.ts:76-81` `assertScoredRungAllowed(kind, scored)` **delegates** to the runtime guard:
  `assertRungAllowedForScored({ isolated: describeGymRunner(kind).isolated }, scored)`, wrapping the
  refusal as non-retryable `GymUnisolatedScoredRun`. It is called in `gymPrepareActivity` (`:151`),
  `runTurn` (`:184`) and `gymScoreActivity` (`:280`).
- `gateway-run-turn.ts:121` `assertRungAllowedForScored` now takes `Pick<TurnRung,"isolated">`, and
  the runtime `runTurn` still calls it at `:449` (`config.scored === true`).

## 2. Failing-first — verified (direct activity probe)

Calling `createGymActivities().gymPrepareActivity` directly:

| attempt | `dcc77b4` (after) | `67dc11f` (before) |
|---|---|---|
| `runner:"local"`, scored default | **refused** `GymUnisolatedScoredRun` nonRetryable, msg `UNISOLATED_RUNG_REFUSED: a scored run requires an isolated (sandbox) rung` | refused, **private** msg `refusing to score a run on the "local" runner…` |
| `runner:"local"`, `scored:false` | **passes the gate** (then `ENOENT … task.json`) | **refused** (unconditional private rule) |
| `runner:"sandbox"`, `scored:true` | passes the gate (control) | passes the gate |

So a scored local attempt is refused with the **shared guard's** message, and an unscored local
attempt now passes the isolation gate — red on the old activity, green after.

## 3. One rule at the activity boundary; a residual driver predicate

The activity layer is unified (both `runTurn` and the gym activities use
`assertRungAllowedForScored`). But a **second, independent predicate remains** at the driver layer:
`src/gym/runner.ts` keeps `scoredAllowed` (`:26,36,38`) and `assertScoredRunnerAllowed` (`:63-64`,
throwing `UnisolatedScoredRunError` with its own message), called by `integrations/gym/run-gym.ts:366`
and `integrations/gym/p2-faults.ts:385`. It is derivable from `isolated` and agreed today (both come
from `describeGymRunner`), and `SCORER-SANDBOX.md` documents it ("the drivers pre-flight with
`assertScoredRunnerAllowed`"), but it is a redundant copy that could drift if a future runner kind
sets `isolated` and `scoredAllowed` inconsistently. Minor; the claim's core ("the activities apply the
same shared guard, no drifting copy *at the activity boundary*") holds.

## 4. Control — verified

A scored sandbox attempt still passes: scripted two-arm durable attempt `outcome=passed`,
`patchBytes=358`, `isolation=gvisor`, `runTurnActivities=2 = turns=2`, `gymPrepare=1`, `gymScore=1`.
The temporal guard tests pass: `gymPrepareActivity refuses a scored run on runner:local` (41),
`an unscored attempt passes the isolation gate on runner:local` (42), `runTurn refuses…` (43),
`gymScoreActivity refuses…` (44).

## 5. Suites + docs — verified

Root **271** (269 pass, 0 fail, 2 live-gVisor skips), temporal **105/105**,
`integrations:syntax` **101/0/3**. The doc fix landed: `docs/SCORER-SANDBOX.md:60-61,156-159` now
says the gym tool path is the runtime sandbox rung (`SandboxWorkspaceExecutor`, including
`workspace.replace`), and the KNOWN-OPEN "scored flag" item is removed (grep empty).

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v12-root.log`, `v12-temporal.log`,
`v12-guard-probe.mts` (run on both worktrees), `v12-main-build.log`, `v12-multiturn.log`.

---

# verify-headline — the real-model durable pass (`gym-runner a266e25`, fix `2b42e71`)

Verified in a worktree at `a266e25` (`5e0b308` + `2b42e71` + `a266e25`), `rm -rf dist` + rebuild.
**SOLID** — I independently reproduced the headline with one real-model two-arm run (this spent
opencode quota, disclosed).

## Independent reproduction (my own run, not the builder's artifact)

`run-gym.ts --arm both --runner sandbox --turns 4 --deadline-ms 150000 --model kimi-k2.7-code` against
the configured opencode-go gateway (`127.0.0.1:8787`, no provider env set), gVisor, pinned image:

| arm | outcome | requested/served | modelSubstituted | isolation | turns | patch |
|---|---|---|---|---|---|---|
| plain (control) | **passed** | kimi-k2.7-code / kimi-k2.7-code | false | gvisor | 4 | 358 B |
| durable (temporal) | **passed** | kimi-k2.7-code / kimi-k2.7-code | false | gvisor | 4 (callCount 4) | **358 B** |

The durable workflow history (`gym-hex-decode-muatvzs3`, fetched from Temporal `:7243`) shows
**`gymPrepareActivity`=1, `runTurn`=4, `gymScoreActivity`=1, `childWorkflows`=[]**, result
`{outcome:"passed", turns:4, callCount:4, isolation:"gvisor", servedModel:"kimi-k2.7-code",
modelSubstituted:false, patchBytes:358}`. `grep scripted` on my log → 0.

## 1. "passed" is the held-out score — verified

`gymScoreActivity` (`gym-activities.ts:285-292`) loads the task, takes `cases = task.hiddenCases`, and
scores via `isolatedScoreGymPatch({ patchText, baseRepoDir, cases })`. The visible test is never the
outcome source.

## 2. The model is real — verified

`servedModel: "kimi-k2.7-code"`, `modelSubstituted: false`, `callCount: 4` in my run; `scripted`
appears nowhere; the only provider is the opencode-go gateway (`/v1/models` lists `kimi-k2.7-code`).

## 3. Failing-first exists and is the same budget/model/task — verified

`/tmp/opencode/orch/headline2-run-20260921T053703Z.log`: same task (`he/hex-decode`), model
`kimi-k2.7-code`, gVisor, `--turns 4 --deadline-ms 150000`, plain `passed` 358 B, durable **`failed`,
`patchBytes: 0`**, `detail: "no changes; the planted bug is still present"`. Its trace shows the first
multi-line `replace_in_file` refused with `old_text occurs 0 times` (two tabs vs the file's four), the
durable arm reaching `finish` with no edit. The pass is the same run after the product fix `2b42e71`.

## 4. The fix is real, not tuning — verified (tests can fail)

`src/execution/text-replace.ts` `replaceInText`: exact-unique first; only when exact occurrences == 0
does the indent-tolerant line match run; the tolerant match must also be unique, and the replacement
is re-indented. `test/text-replace.test.ts` is **7/7**. Breaking the guard in the worktree, rebuilding,
running, restoring:

| break | result |
|---|---|
| remove the indent-tolerant fallback | **test 5 red** (`wrong leading indentation falls back…`) |
| remove the tolerant uniqueness guard (`starts.length !== 1` → `=== 0`) | **test 7 red** (`ambiguous indent-tolerant match is still refused`) |

Tool-level and pod-level regressions also pass: `gym-tools` "replace_in_file tolerates wrong leading
indentation instead of losing the edit", `sandbox-workspace` "workspace.replace tolerates wrong
leading indentation (the live durable failure)".

## 5. Turn-per-activity — verified

My run's durable history: `runTurn` activities **4** == `turns` **4** (and `gymScoreActivity` 1).

## 6. The honest note — true, and which bar item it meets

`durableAgentWorkflow` is **not** referenced in the gym path (`grep` over `gym-activities.ts`,
`gym-workflows.ts`, `run-gym.ts` → empty), and my run's history has **no child workflow**. The gym
workflow owns the loop and calls `runTurn` directly. That **meets bar item 1** ("agent turns, gym
attempts … are Temporal workflows, activities, or child workflows; no production in-process loop
outside Temporal") — the path is Temporal-native. It does **not** meet the narrower `gym-2` target
("the gym drives the runtime agent workflow / `durableAgentWorkflow`"), which is a design divergence
the builder states rather than hides; it is the same "one leaf vs gym-owned loop" tension already in
`docs/GYM-ONE-TURN.md`.

## Suites

Root **312** (310 pass, 0 fail, 2 live-gVisor skips), temporal **88/88**.

**Repo untouched** (only the worktree). Artifacts: `/tmp/opencode/orch/v13-root.log`, `v13-temporal.log`,
`v13-text-replace.log`, `v13-breakA.log`, `v13-breakB.log`, `v13-headline.log` (my real-model run),
`v13-one.mts` history output, `v13-worker.log`.

---

# verify-gym7 — **the requested task file is missing**; verified gym-7 anyway

**`/tmp/opencode/orch/TASK-verify-gym7.md` does not exist.** The only `gym7` artifacts are the
*builder* task `TASK-gym-7.md`, the builder report `gym7-report.md`, and `gym7-*.log`/
`/tmp/opencode/gym6/gym7-history.json`. I took the measurable interpretation — verify the gym-7 work
reported in `gym7-report.md` (commit `gym-runner c023f29`) — and say so here. If a different task was
intended, the file needs to be written.

## gym-7 (decision (b): the gym owns its loop) — SOLID

Verified in a worktree at `c023f29` (`rm -rf dist`, rebuild).

- **The decision matches the code.** The gym path uses
  `gymAttemptWorkflow → gymPrepareActivity → runTurn (×N) → gymScoreActivity`
  (`integrations/temporal/src/gym-workflows.ts:74-102`); `grep durableAgentWorkflow` over
  `gym-workflows.ts`, `gym-activities.ts`, `run-gym.ts`, `src/gym` → **none**. My live scripted
  sandbox attempt's history shows **no child workflow**.
- **The justification is precise (file:line):** bounded attempt with `maxTurns`/`deadlineMs`
  (`gym-workflows.ts:74-85`) and a growing transcript it owns (`:76,96-99`) vs the long-lived
  interactive mailbox lifecycle (`workflows.ts:47-75`, mailbox snapshot `:100-107`); the gym harvests
  the patch/checkpoints and reads `finish` (`gym-activities.ts:240-258`) then scores held-out
  (`gym-workflows.ts:102`); the spec itself keeps `durableAgentWorkflow` as the leaf
  (`SPEC-super-harness.md:48`).
- **The bar and the docs now agree.** `/tmp/opencode/orch/SPEC-super-harness.md:37,54-62` was updated:
  the gym row / gym-2 bullet say the durable arm is a bounded Temporal workflow calling the shared
  `runTurn`/`GatewayAgentEngine`, and `durableAgentWorkflow` stays the interactive lifecycle.
  `docs/GYM-ONE-TURN.md` has the "Decision (gym-7)" section. **No claim contradicts the code.**
- **Bar item 1 holds:** the path is Temporal-native (`gymAttemptWorkflow` + `runTurn` activities), it
  runs the one turn body (`GatewayAgentEngine`), and there is no production in-process loop outside
  Temporal. The only gym-specific part is the bounded attempt container.
- **The pin can fail.** `test/gym-durable-path.test.ts` test 5 asserts `gym-workflows.ts` contains no
  `durableAgentWorkflow`/child-workflow reference. Breaking it (adding a reference), rebuilding →
  **test 5 red** ("gym-workflows.ts must not reference durableAgentWorkflow"); restored → green.
- **Live scripted sandbox attempt still passes** (zero quota, my own run): `childWorkflow=(none)`,
  `outcome=passed`, `patchBytes=358`, `isolation=gvisor`, `turns=2`, `runTurnActivities=2`,
  `gymPrepare=1`, `gymScore=1`.
- **Suites:** root **313** (311 pass, 0 fail, 2 live-gVisor skips), temporal **88/88**.

**Repo untouched.** Worktree `v14-gym` used and removed. Artifacts: `/tmp/opencode/orch/v14-root.log`,
`v14-temporal.log`, `v14-pin.log`, `v14-break.log`, `v14-multiturn.log`.

---

# bar-audit (re-run) — SPEC-super-harness vs `main deba5fc`

Full scorecard rewritten at `/tmp/opencode/orch/bar-scorecard.md`. Fresh worktree, `rm -rf dist` +
rebuild, Node 22. `gym-runner c023f29` is **merged** (`main..gym-runner` = 0). Reproduced at
`deba5fc`: root **287** (285 pass, 0 fail, 2 skip), temporal **105/105**, syntax **102/0/3**,
secret-scan clean, root `dist/` tracked 0.

| # | item | verdict |
|---|---|---|
| 1 | Unify under Temporal | **MET** |
| 2 | Stateful harness | **MET** |
| 3 | Complex flows / graphs / loops | **MET** |
| 4 | Providers direct and pluggable | **MET** |
| 5 | Even synth, no exception | **MET** |
| 6 | No hallucinations | **PARTIAL** |
| 7 | Verification is adversarial | **PARTIAL** |

Executed evidence: one turn body (`gateway-engine.ts:143`); gym turn-per-activity in the live history
(`gymPrepareActivity` 1, **`gymRunTurn` 2 == turns 2**, `gymScoreActivity` 1, **0 child workflows**);
one production worker entry (`worker-entry.ts:90-107` bundles both workflows + all four activities);
mailbox/graph-journal/receipts in Temporal state (`effect-receipt-live` → `firstEffectExecutions 1`);
all four graph live proofs green (`graph-restart` pre=1/iter=3/left=1/right=1/hang=2;
`graph-child`; `graph-continue-as-new` runCount 2 / 1100 iters; `graph-cancel` 3/3 cancelled);
provider fake-server attack switches provider by config alone; the scored-rung rule is now one shared
predicate (`src/execution/scored-rung.ts`) with `scored:true` set by production callers
(`run-gym.ts:310`, `p2-faults.ts:161`) and the attack confirms scored-local refused, unscored-local
passes, sandbox passes.

**Findings.** (6) **README:171-178 is stale**: it says "on commit `HEAD`" 271 tests / 269 passed,
temporal 104, syntax 101, but at `deba5fc` the measured numbers are 287/285, 105, 102. Everything
else audit-1 flagged is fixed (stale LIVE-PROOF/LIVE-CONTRACTS gone, deleted-API docs fixed, dist
untracked, receipt/clock/256/rate-limit claims reconciled, SCORER-SANDBOX tool-path paragraph fixed).
(7) `docs/VERIFICATION.md` + `scripts/verify.mjs` + a CI Temporal-proof job are in-repo, but the
adversarial findings/rolling audit still live in `/tmp`, lost on reboot.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v15-root.log`, `v15-temporal.log`, `v15-syntax.log`,
`v15-attack.log`, `v15-calls.log`, `v15-graph-*.log`, `v15-multiturn.log`, `v15-guard-probe.mts`,
`v15-hist.mts`.

---

# bar-audit (re-run 3) — `main eac94c9` closes items 6 and 7

`eac94c9` ("Final: verified README numbers, durable claim audit") landed after my `deba5fc` scorecard.
Verified in a fresh worktree (`rm -rf dist` + rebuild). **All seven bar items are now MET.**

## What closed

- **Item 6 — README staleness fixed and guarded.** `README.md:171-181` now says **287 tests: 285
  passed / 2 skipped, temporal 105, syntax 102 TS**, exactly the measured numbers at `eac94c9`
  (reproduced: root 287/285/2, temporal 105/105, syntax 102/0/3). `scripts/readme-numbers.mjs` parses
  the suites' own TAP/JSON and compares to the README: executed capture → "README matches the measured
  run", exit 0; **mutated tap (`pass 285 → 286`) → exit 1** with `root.pass: README says 285, measured
  286`. Wired into `npm run verify` and CI (which tee the suite output). `docs/RESPONSES.md` now
  cites the real test path.
- **Item 7 — the adversarial audit is durable and in-repo.** `scripts/claim-audit.mjs` commits the
  curated claim→artifact registry (one turn body, turn-per-activity, one worker entry, one scored-rung
  rule, pinned executor, effect receipts, sandbox boundary, supervisor Schedule, channel sweep, …)
  plus reconciliations (every backtick repo path in current README/docs exists; README numbers match a
  run; `git` tracks no `dist/`), with `--live`. Executed static → `17 checked, 0 skipped, 0 finding(s)`,
  exit 0; **breaking `src/gym/runner.ts`'s `scoredRungAllowed` call → 1 finding / exit 1**
  (`one-scored-rung-rule … does not call the shared predicate`). Wired into `scripts/verify.mjs` and
  CI (`core.yml` test + temporal jobs).
- `npm run verify` → **exit 0**: root, temporal, syntax, secret-scan, README numbers, claim audit,
  and 6/6 Temporal live proofs.

## Final verdicts (`main eac94c9`)

| # | item | verdict |
|---|---|---|
| 1 | Unify under Temporal | **MET** |
| 2 | Stateful harness | **MET** |
| 3 | Complex flows / graphs / loops | **MET** |
| 4 | Providers direct and pluggable | **MET** |
| 5 | Even synth, no exception | **MET** |
| 6 | No hallucinations | **MET** |
| 7 | Verification is adversarial | **MET** |

Remaining, all disclosed in `KNOWN-OPEN.md`: graph branch unit-only + compensation/per-node-timeouts/
HITL unbuilt; residual host isolation (labelled control arm, synthetic rung by design; host-worker
network/`node:test`-run/`process.kill`/metadata channels open, pod is the boundary); per-run provider
selection not threaded; the historical RC live claims (Pi E2E, external-provider matrix) labelled
"not re-runnable". No current-fact first-page claim is unbacked.

**Repo untouched.** Artifacts: `/tmp/opencode/orch/v16-*.log`, `v16-root.tap`, `v16-temporal.tap`,
`v16-verify.log`, `v16-claim.log`, `v16-claim-break.log`.

---

# verify-bw — boundary-1 (`main 83edfc3`) and workspace-1 (`gym-runner 69a782e`)

## boundary-1 — **SOLID**

Verified in a worktree at `83edfc3` (`rm -rf dist`, rebuild), Node 22, live gVisor.

- **No machine pins.** `grep -E "/home/tiny|10\.91\.1\.1|10\.43\.0\.1"` on
  `test/gym-sandbox-boundary.test.ts` → none. The parent `83edfc3^` hardcoded
  `HOST_REPO=/home/tiny/…`, `HOST_NODE_IP=10.91.1.1`, `CLUSTER_API=10.43.0.1`. Now
  `SYNTH_BOUNDARY_HOST_REPO` (default cwd), `_HOST_TEMPORAL`/`_HOST_GATEWAY` (default the loopback
  listeners `127.0.0.1:7243`/`:8787`), `_CLUSTER_API` (derived from `kubectl`), `_INTERNET`
  (default `1.1.1.1:443`), and `_NODE_IP` (optional).
- **Live, default env → 5/5** (`SYNTH_LIVE_GVISOR=1` + pinned image + ns/runtime): the four rules
  (network-probe control, network rule two-cases+control, filesystem rule two-cases+control, local-run
  refusal) and "the gVisor pod cannot see the host, the vectors, or reach host TCP".
- **Positive control can fail (attacked).** `SYNTH_BOUNDARY_HOST_TEMPORAL=127.0.0.1:9` (closed port) →
  the gVisor test is **red**: `positive control failed: the host Temporal (127.0.0.1:9) is not
  reachable from the host, so "the pod cannot reach it" cannot be asserted`.
- **Parameterised (no false red).** `SYNTH_BOUNDARY_HOST_REPO=/tmp/opencode/not-tiny-repo` → green.
- **Each network claim is independently asserted:** `assertNetworkDenied` iterates targets and, per
  target, first asserts the host control is `CONNECTED`, then asserts the pod is not — so the old
  vacuous node-IP assertion (no listener) and the control-arm-throws-on-gVisor-first gap are gone
  (the parent's control `assert.throws` fired on `gvisor` and never reached the network assertions).
- Suite: root **290** (288 pass, 0 fail, 2 live-gVisor skips) — matches the commit.

## workspace-1 — **SOLID, with one correction to the task's premise**

Verified in worktrees at `69a782e` and `69a782e^`, live gVisor, scripted gateway, SIGKILL mid-turn-2.

- **Call path.** CHECKPOINT: `runTurn` (`integrations/temporal/src/gym-activities.ts`) →
  `sandbox.checkpointWorkspace(blobs)` (`integrations/gym/sandbox.ts:228`) →
  `checkpointSandboxWorkspace` (`src/execution/kubernetes/sandbox-workspace.ts:261`) → digest stored as
  `GymCheckpoint.workspaceDigest` (`src/gym/checkpoint.ts:45`); pointer in `BlobGymCheckpointStore`.
  RESTORE: on a cold worker, `getPersistentSandboxRunner` is passed `restore:{blobStore,digest}`
  (`gym-activities.ts:204`) → `restoreSandboxWorkspace` (`sandbox.ts:194`) into the cache before the
  Pod materializes. One `FileSystemBlobStore` holds both the record and the diff — **no second store**.
- **Executed (my own orchestration).** `69a782e` kill+resume → `ok:true`, `outcome:passed`,
  `patchBytes:358`, `turns:2`; the checkpoint record carries
  `workspaceDigest:"sha256:9c991093…"`, which resolves to a blob in the same store.
- **Correction — the task's failing-first premise is not reproduced.** At `69a782e^` the SAME
  kill+resume also **passed, 358 B**: `^` already had a legacy cold-restore that replays the harvested
  `patchText` with `git apply` (its checkpoint record has `patchText` and no `workspaceDigest`). So `^`
  does not lose the edit here. The true discriminating control is disabling the new digest restore on
  `69a782e`: then the same kill+resume → `failed`, `patchBytes:0`, `"no changes"` (the legacy block is
  skipped because a digest is present). Unit test: green; breaking `sandbox.ts`'s restore → red
  ("the resumed pod must hold the checkpointed edit").
- Suite: root **314** (312 pass, 0 fail, 2 live-gVisor skips), temporal **88/88** — matches the commit.

**Repo untouched.** Worktrees `v17-bd`/`v17-ws`/`v17-ws-prev` used and removed. Artifacts:
`/tmp/opencode/orch/v17-bd-live.log`, `v17-bd-closed.log`, `v17-bd-nontiny.log`, `v17-bd-root2.log`,
`v17-ws-unit.log`, `v17-ws-break.log`, `v17-runA/`, `v17-runB/`, `v17-runC/`, `v17-ws-root.log`,
`v17-ws-temporal.log`.

---

# verify-leak — per-pod NetworkPolicies cannot be orphaned (`gym-runner 0e649f3`)

Verified in worktrees `v18-leak` (`0e649f3`) and `v18-leak-prev` (`0e649f3^`), `rm -rf dist` + rebuild,
live k3s `gvisor`. **SOLID.**

## 1. The change — verified

- `src/execution/kubernetes/manifests.ts:203-212`: `buildSandboxNetworkPolicy(…, owner?)` sets
  `metadata.ownerReferences: [owner]` when an owner is given (omitted otherwise, so the old manifest
  shape is preserved for callers that pass none).
- `src/execution/kubernetes/kubectl-backend.ts`: `create` applies the Pod, then `#podOwner`
  (`:326-334`) reads `{.metadata.uid}` and passes it in; it **refuses** to create an unowned policy.
  `destroy` → `#deletePodAndPolicy` still deletes `pod/X networkpolicy/X-network` (unchanged).

## 2. Failing-first — verified (out-of-band pod delete)

My own probe (create via `KubectlSandboxBackend`, `kubectl delete pod … --wait=false`, wait, check):

| tree | podGone | policyLeaked |
|---|---|---|
| `0e649f3^` | true | **true** (orphan) |
| `0e649f3` | true | **false** (GC'd via ownerReference) |

## 3. Destroy path still works — verified

Standalone probe: `create` → `{pod:true, policy:true}`; `backend.destroy` → `{pod:false, policy:false}`.
The live test's case (1) (create → destroy removes both) is green.

## 4. Leftovers 20 → 3, and a fresh run adds none — verified

`kubectl get netpol -A | grep -c synth-sandbox` = **3 before and 3 after** my red probes and the
destroy probe; the `0e649f3^` probe's orphan was swept by the probe. No new orphan from a fresh
create/delete cycle.

## 5. Boundary + no regression — verified

- Live `test/gym-sandbox-boundary.test.js` at `0e649f3`: **2/2** ("the boundary contract rejects a
  local run", "the gVisor pod cannot see the host, the vectors, or reach host TCP").
- The policy spec is unchanged: the headless test still asserts egress to DNS port 53 and the egress
  proxy port 3128 (`test/kubernetes.test.ts:142-143`), and the headless ownerReference test asserts
  the owned/unowned shapes.
- Suites: root **316** (313 pass, 0 fail, 3 skipped — the new live test skips without a cluster),
  temporal **88/88** — matches the commit.

**Repo untouched.** Worktrees `v18-leak`/`v18-leak-prev` used and removed. Artifacts:
`/tmp/opencode/orch/v18-live.log`, `v18-boundary.log`, `v18-root.log`, `v18-temporal.log`,
`v18-red-probe.mjs`, `v18-destroy-probe.mjs`.

