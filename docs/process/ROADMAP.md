# synth-agent-runtime — working roadmap

Repo: /home/tiny/projects/pisynth/synth-agent-runtime (public, push to origin/main).
This file is the standing work queue. When a task finishes, move to the next one WITHOUT
waiting to be asked. Each task has its own spec file; this is the order and the reasoning.

> **TOP PRIORITY as of 2026-09-21 — read `/tmp/opencode/BRINGUP-PLAN.md` first.**
> A clean machine (`big`, 10.92.1.1, ssh via `<ssh-key>`) was provisioned for
> the first end-to-end run. The system has never been run as a whole: the chain
> `agentId → workflow → effect → sandbox → pod → receipt` has not once been executed in a
> single run, and that is a larger gap than any defect found in seven review rounds.
> That plan carries the measured machine state, nine known defects that will block or
> mislead, the ordered steps, six gates and three decisions for the owner.
> Everything below is secondary until a first run exists.

Working rules that apply to everything below (these were learned the hard way, do not drop them):
- Small pieces. One item at a time, fully green before the next. No large untested drops.
- Failing-first for every new test: break the thing it covers, confirm the failure message is
  the expected one, restore. Record it.
- Live proofs, not mocks, for anything touching Temporal, the executor rungs, or inference.
- A test must be able to fail for a real reason. Assert the discriminating quantity (timing,
  call counts), not just a final status — a status assertion often passes on the broken code.
- A skip is never `ok:true`. Distinct outcome, exit code 2.
- No claim in a results table without an executed artifact behind it.
- Secret scan before every push; public repo. Never commit `integrations/*/dist/`.
- Do not touch the `feat/temporal-harness-bridges` branch / PR #1 (another agent owns it).
- Compact your context before it gets full, not after.

## Done (verified independently, live infra)

- Park semantics: a transient failure parks instead of killing the agent (26fc043).
- Test suite tracks 1-6: real repos, messy corpus, seeded generators, fault matrix, mixed
  chains, Temporal replay/signals/restart (e4397ec … 0ca8075).
- Vacuous-skip fix in the real-rung proof (251d59b).
- Activity-returned `waiting` no longer spins the workflow; the generator now fuzzes the
  returned state too, so the whole bug class is reachable (abf931a).
- Corpus CVE items relabelled to `news`; gate re-measured (6e0af80). NOTE: the scored subset
  is now 12/12, so the gate is a REGRESSION DETECTOR, not a difficulty measure. The corpus's
  real value is the ambiguous and adversarial items, scored structurally.
- `two-workers-race` proven against live Postgres (16 workers, one lease winner, fencing
  enforced); `clock-jump` removed from the matrix into an explicit not-covered list (88d9daa).
- Server retry hints honoured in the durable park path; `402` is now permanent (5389dee).

## CURRENT QUEUE (updated 2026-09-20, after review round six)

Ordered. Nothing below is done; everything above it in the file that is marked done, is.

1. **Both scorers are STILL forgeable** (review round six, executed evidence).
   - `main` `bf56bca` — **DONE on main @ `64cac44`**: the in-clone HMAC harness is removed and
     replaced with the isolated verifier (verifier holds the held-out vectors; worker only
     reports raw values; Node permission model confines the worker). The signing-oracle payload
     went `passed` → `errored`; plus a leaf-symlink survivor fixed in `ff7ab93`, a node:sqlite host escape closed in `1a55a4c`, and a probe showing the worker is NOT isolated in `036121b` (TCP/unix/kill/userInfo reachable; OS boundary required, not built) (deny the builtin; permission model is a guardrail, not a boundary) (checkout symlinks resolved, escapes refused as tampered). FORGE 1-6 are permanent regression tests in
     `test/gym-vacuity.test.ts`; `scoreGymPatch` now takes `cases`, not `hiddenTestPath`.
   - `gym-runner` `f697904`: the verifier/worker split is the better shape, but the worker runs
     unsandboxed on the same host and the expected values ship as
     `test/fixtures/gym-tasks/<repo>/<slug>/hidden.cases.json`. The worker finds the verifier's
     cwd via `/proc/<ppid>/cwd` and reads them. Real `he/hex-decode`, bug untouched → `passed`.
     A ground-truth leak, not a protocol forgery; for a code-fix task it is cheating.
   - **Standing requirement:** every demonstrated attack becomes a PERMANENT regression test.
     The existing FORGE 1–3 cover env nonce, early exit and assert mutation but not these, which
     is exactly why each redesign reopened the hole through the channel it did not consider.

2. **The gym merge is broken.** `c889243` merged main into gym-runner and the combined tree is
   254/261 — the failures are the core gym tests including the golden-patch control and
   checkpoint recovery. `1d0fe68` decided the shape (isolated verifier). Must be re-verified
   THREE ways before anyone calls it merge-ready: full suite, both forge attacks, and the golden
   control. The attacks alone look safe on a scorer that rejects everything.

3. **Signal swarm (5b)** — started on main, then interrupted. Spec: spec-signal-swarm.md.

4. **Remaining KNOWN-OPEN entries** — the smaller ones; the four large ones are closed.

5. **The session supervisor is built and tested but NOT deployed** — it does not yet replace the
   hand-run monitor loop.

6. **OpenRouter limits/prices stay UNMEASURED** — the coordinator's own unverified claim, kept
   labelled rather than quietly asserted. Needs a key we do not have.

## Next, in order

**The agreed plan is `/tmp/opencode/PLAN-next.md` (approved 2026-09-20).** It supersedes the
ordering below where they differ: P0 model visibility (plus a LiteLLM profile to make provider
agnosticism a demonstration rather than a claim), then P1 the gym end-to-end runner in seven
steps, then P2 the control arm and faults, then P3 signals built on the gym pipeline.
The half-remembered gateway was LiteLLM, not "tinyllm" — question closed.


**Queue status updated 2026-09-20:** rung parity (1) and priority lanes (2) are committed.
`/tmp/opencode/review-followups.md` is fully addressed (65d2336, e36102b, b14ef7d, 85a3b39,
0c8ed61, f56efc5) and the review-findings rounds 1-3 are worked through: retry-hints
consolidated, fault-matrix evidence predicate fixed, real-429 assertion fixed, lane property
test added, blob receipt test fixed, docs/CHANGELOG/bookkeeping done. Remaining review items are
design/CI tasks, recorded in `docs/KNOWN-OPEN.md`. NEXT: the gym runner half (item 4), then
adaptive scarcity (item 3).

Also corrected: "test suite tracks 1-6 — Done" above over-claims. Track 1's K8s-side clone/sync
and the interrupted-sync case were never written, as the results doc itself admits.

### 0. Model visibility — spec: `/tmp/opencode/spec-model-visibility.md`  [DONE]
All three gaps closed: `models:list` prints the catalog with provider/profile and discovery is
never filtered (7c032b9, live 27 models); `requestedModel`/`servedModel`/`modelSubstituted` are
recorded without guessing (112af89); `corpus-model-compare` runs one measurement across an
explicit model list with a printed call budget (879996e). Rate-limit scope was measured and is
inconclusive at 80 concurrent with no throttle (c0dda06) — see docs/KNOWN-OPEN.md.

### 4. The gym milestone — spec: `/tmp/opencode/spec-gym-milestone.md`  [IN PROGRESS — scoring half DONE]
Scoring half is done and trustworthy: `src/gym/scoring.ts` scores the diff on a fresh checkout
against a held-out test, tampering is a distinct outcome, and `passed` is not forgeable by
agent code (TAP + per-run nonce marker + frozen assert; f7d1241, 4402de2, eb39d4e). Failing-first
evidence in docs/VERIFICATION-LOG.md. NEXT: the runner half per /tmp/opencode/PLAN-next.md P1
(task.ts, tools.ts, harvest.ts, attempt.ts, two arms, run-gym.ts) — nothing yet plants a bug,
provisions a sandbox, runs an agent, or harvests a patch.
Take the Track 1 pinned real repos, plant a genuine failing test, have swarm agents fix it
inside gVisor. Ground truth is objective — does the test pass — so NO judge is needed.
Exercises the whole stack: durable turns, mixed chains, escalation, receipts, real inference,
real repos. Include the honest control: the same task without the runtime.
Guard against cheating, which is the main design risk: the test file must be read-only to the
agent, and the fix must be validated by a separate test the agent never sees. Otherwise the
agent deletes the test or makes it trivially green.

### 3. Adapt to scarce quota — REOPENED 2026-09-20 evening: the constraint DOES bind

**Correction to the drop below.** The measurement that justified dropping this was 1000
concurrent calls with no throttling, and the conclusion recorded was "no practical limit binds
at our scale". That conclusion was wrong because it measured the wrong axis: it tested
CONCURRENCY over ~20 seconds and found no per-minute rate limit, which is true. The account
has a WEEKLY quota, and it was exhausted this evening — two agents stopped with "weekly usage
limit reached, resets in 8 hours".

So the binding constraint is a budget over a long window, not a rate over a short one. That
changes what an adaptation would even be: an AIMD concurrency controller regulates a rate and
would not have helped at all here. What matters instead is spend per unit of work — fewer,
larger batches; cheaper models for the mass and expensive ones only where they earn it; and
not re-running a measurement that can be re-scored from stored artifacts.

Note the checkpoint result is already evidence of this kind of saving: recovery after SIGKILL
went from 8 model calls to 2 because the resumed attempt did not redo the work.

Keep the original text below for its reasoning, but do not act on its conclusion.

### 3-original. Adapt to scarce quota — the earlier DROPPED entry, conclusion superseded
Measured and concluded (`bca5670`, `npm run live:rate-limit-scope`): 1000 concurrent calls to
one cheap model returned 998x200 in ~20s with two transient 5xx, zero 429/402, no rate-limit
headers, and a second model was unaffected immediately after — roughly 3000 req/min-equivalent
with no throttling. The probe classifies 429/402 separately from 5xx precisely because the
gateway masks upstream errors as 5xx, so the two transient failures are not throttling.

Therefore an AIMD or similar adaptive-concurrency controller would regulate a constraint that
does not exist at our scale, and building one would be complexity with no measured benefit.
Dropped deliberately, not forgotten. Revisit only if a future measurement finds a real limit.
The mailbox batching adaptation remains as an emergent behaviour worth measuring if latency
rather than quota ever becomes the binding constraint.

### 3-superseded. Adapt to scarce quota (original text, kept for its reasoning) — spec: `/tmp/opencode/spec-adaptive-scarcity.md`
Decided 2026-09-20: more accounts are NOT coming for a while, and the single-account
constraint is being treated as the operating condition and a deliberate stress test rather
than a blocker. The system should discover and hold the sustainable rate and spend scarce
quota on the most valuable work, instead of waiting for headroom. Build on what exists
(retry hints, quota-exhaustion signalling, lanes, mailbox batching); measure a baseline
first, and drop any adaptation that does not beat it.

### 5. Temporal as a durable "poke" scheduler for interactive agents

The idea: run a SEPARATE Temporal (in k3s) whose only job is to supervise interactive agent
sessions — the ones living in tmux panes or in herdr — on a schedule, and nudge them.

This is not speculative: it is exactly the loop being run by hand today, and that loop is
demonstrably fragile. The current supervisor is a 30-minute background monitor that must be
re-armed by hand, plus `tmux capture-pane` output scraped for the string "esc interrupt" to
guess whether the agent is busy, plus `tmux send-keys` followed by a separate Enter and a
capture to confirm the message actually went in (it silently did not, more than once).
Every one of those is a durability problem that Temporal already solves: retries, history,
signals, schedules, and survival across restarts.

Design points that matter:
- **Keep it separate from synth's own Temporal.** The supervisor must not live inside the
  system it supervises, or restarting/testing that system takes the supervisor down with it.
  A small k3s Temporal is the right shape.
- **Use herdr's state API instead of scraping a terminal.** herdr (herdr.dev) is a
  tmux-like multiplexer built for coding agents: it natively tracks idle/working/blocked/done
  per pane and exposes a CLI and socket API that scripts and agents can drive. That turns
  "grep the pane for a magic string" into a real signal. Keep the tmux scrape as a fallback
  for panes that are not under herdr.
- **One workflow per supervised session**, with signals for human redirection, a schedule for
  periodic check-ins, and an escalation path when a pane stays blocked past a threshold.
- **Be honest about what this is**: a supervisor that watches workers and pokes them. Useful,
  and slightly Orwellian. That framing should be in the docs, not hidden.

Prerequisite: none technically, but it is worth doing only after rung parity, because it is
infrastructure for running the work rather than the work itself.

### 5b. Signal swarm on the gym pipeline — spec: `/tmp/opencode/spec-signal-swarm.md`
The user's chosen sequencing: the code-fixing gym was built first so this could reuse it.
Everything carries over except the ground truth. Stage one plants findings in the stream and
scores objectively, NO judge. Stage two adds the judge only for open-ended findings, and only
after the judge itself is measured against the planted set for recovery, stability,
independence and cost per judgment.

### 6. Evaluator / judge — last, and only when needed
The "mass of cheap models plus a few frontier judges" idea. Deliberately last: judging is the
hardest thing to verify, so do it only for open-ended tasks where no objective answer exists.
Task 4 deliberately avoids needing it.

## Known open items
- `clock-jump` is honestly not covered; covering it needs an injectable clock in the runtime,
  which is a structural change, not a test.
- `CORPUS_BASELINE` records the measurement date as 2026-09-19; it was measured 2026-09-20.
  Fix the date — the point of a provenance field is that it can be trusted.
- The fault matrix's per-row check verifies that evidence CITES an executed artifact; it does
  not verify the artifact actually ran in this session. Stronger would be to record and check
  run outputs.
- Root `dist/` is deliberately tracked in git (160 files). That is the existing convention;
  `integrations/*/dist/` is correctly ignored.

## Completed in this push (kept for their rationale)

### 1. Rung parity — spec: `/tmp/opencode/spec-rung-parity.md`
Make the synthetic rung a faithful, trustworthy simulation of the real one. Six divergences
are already measured (missing-path read/delete/list all return ok:true, deleting a directory
leaves children readable, writing under a file path succeeds, `../` traversal write succeeds).
The real filesystem is the oracle. Build the differential harness first.

Why it matters: `integrations/pi-synthetic-git-prototype` runs Pi's real tools against a
fully in-memory workspace. If the synthetic rung lies, every cheap in-memory run teaches
something false. This is the precondition for cheap mass simulation.

### 2. Priority lanes / fair-share across accounts
`src/inference/gateway/tenant-policy.ts` has no priority, tier, weight or quota concept —
greenfield. The runtime will run on a few cheap SUBSCRIPTION accounts, so the scarce resource
is quota in a time window, not money. A lane decides who gets scarce quota.
2026 practice to follow: priority bands, fair-share by weight within a band, queue-or-reject
backpressure that passes `Retry-After` downstream. Needs a written spec before any code.
Precondition: backpressure must be correct first (task done in 5389dee).

### 2c. Artifact egress [DONE — all four mechanisms, provenance with gap reporting, and handoff by reference proven: a 4 MB artifact size delta moved workflow history by 17 bytes]

## Blocked

### 3b. Multi-account routing under real load [BLOCKED — no accounts]
`integrations/pi-opencode-stack-router` already presents several OpenCode Go accounts to Pi
as one provider, but it has never run with more than one real account. When 3-6 accounts
exist: kill one mid-run, prove failover, sticky affinity, and that quota is spread. Until the
accounts exist, this is blocked — do not fake it.

## Context and corrections (not tasks)

### 3-pre. Provider agnosticism — CORRECTION to the framing above (2026-09-20)

The coordinator kept framing capacity around ONE provider's subscription and its accounts.
That was narrow, and the user corrected it. The architecture is already provider-agnostic and
has been all along:

- `GatewayBackend` (src/inference/gateway/types.ts:7) is two methods — `listModels()` and
  `handle(request, model)` — a plain OpenAI-compatible passthrough.
- `http-upstream.ts` is the generic implementation: ANY OpenAI-compatible endpoint plugs in.
- `ProfileRouterBackend` already does failover, cooldown and sticky affinity across PROFILES,
  and a profile is any backend — not "one account on one provider".

So "multi-account routing" was the narrow version of **multi-profile routing across
providers**, which needs no new accounts at all: the OpenCode Go subscription, OpenRouter, a
local model and anything else can sit behind the same router today.

Two measured facts that belong with this:
- The subscription exposes **27 models**, not one. `modelIds` in the probe host
  `/tmp/opencode/audit/pi/ogw-host.mts` is a FILTER (adapter.ts:54 — `allowed`), and it had
  been hardcoded to `muse-spark-1.3-contributor`. Every accuracy and latency number recorded
  so far is that one model's number. Full list captured 2026-09-20: deepseek-v4-pro,
  deepseek-v4.1-flash, deepseek-v4-flash, glm-5.1/5.2/5.3/5.3-flash, kimi-k2.6/k2.7-code/k3,
  qwen3.6-plus/3.7-max/3.7-plus/3.8-max/3.8-flash, gpt-5.6-luna, grok-4.6, minimax-m2.7/m3,
  longcat-2.0, mimo-v2.5/pro, hy3, hy4-preview, muse-spark-1.2/1.3-contributor.
- Therefore the cheap-mass-plus-frontier-judge design (item 6) is achievable on ONE
  subscription, and model diversity is a capacity strategy available NOW.

Before building adaptive concurrency (item 3), measure whether rate limits are per-model,
per-account or per-provider. That one cheap measurement decides which lever actually works,
and listing models costs no quota. Do not assume.

Open question from the user, unresolved: they half-remembered a "tinyllm adapter". Nothing by
that name exists locally (searched the repo and the filesystem). Ask them what they meant
rather than guessing.

### 2b. Materialization boundary — symlinks (SUPERSEDED, see 2c and review-followups)
The open design question here is closed: symlinks are preserved, and the target is resolved
relative to the link's parent before the containment check. The first version of that decision
used `escapesWorkspace` on the raw target, which was wrong in both directions. Kept for history:
Measured 2026-09-20 against the live sandbox: everything round-trips except symlinks. A
symlink created in the sandbox (`ln -s regular.txt link.txt`) comes back through
MemoryWorkspace as a **regular file containing the target's content**, not a link. Track 1
already proved `NativeGitSource` preserves symlinks (`kind: symlink`), so git-side they are
first class; the sandbox return path flattens them (a real repo round-tripped through an
exec would show mode 120000 → 100644 in git). Treat this as a **design question, not a
bug**: either preserve symlinks and validate the target stays inside the workspace (an
in-workspace symlink to `/etc/passwd` is an escape vector), or flatten deliberately and
document it. Decide, argue it in one paragraph, and pin it with a test either way. Do not
start before priority lanes.

Scoped API surface (there is currently NO workspace effect that can create a symlink, so
"preserve symlinks" needs new surface — scope this before building it):
- New effect kind `workspace.symlink { path, target }` and `MemoryWorkspace.symlink(path,
  target)`, with `stat` returning `kind: "symlink"` and `read` returning the target bytes
  (done for source-backed reads in 0c8ed61; overlay links still needed).
- Materialize/syncBack must preserve mode 120000 rather than flattening: `WorkspaceSynchronizer`
  and `KubectlSandboxBackend.writeFile`/`listGitChanges` need symlink-aware write/read (write a
  link, do not follow it, report it as a change).
- Validation helper `resolveSymlinkTarget(linkPath, target)`: resolve `target` relative to the
  link's OWN parent, normalize, then check the RESOLVED path is inside the workspace. Reject
  escaping targets with `WORKSPACE_PATH_ESCAPES`. Chains: resolve with a depth limit and reject
  cycles. Dangling links: a link whose target does not exist is still a valid link — keep it.
- Validation runs at creation and again on materialize/syncBack import.
- Tests: pure validation (`../other-dir/pm` from `tests/fixtures/another-dir/` must be KEPT;
  `/etc/passwd` and a target that climbs out must be rejected; chain, cycle, dangling), plus a
  live sandbox round-trip proving a created link comes back as mode 120000, not a regular file.

### 2c-original. Artifact egress — spec: `/tmp/opencode/spec-artifact-egress.md`
How the results of a sandboxed agent run get OUT, provably. Four mechanisms, all of them:
bounded inline snapshot, git as the primary transport for code work, patch extraction for
change proposals, and a content-addressed blob store for everything else. Hard constraint:
artifacts never flow through Temporal workflow history — the workflow carries a `sha256`
reference, the content travels out of band, and every receipt records the digest.
Decided, not open: symlinks are PRESERVED with target validation (escaping links rejected
with `WORKSPACE_PATH_ESCAPES`), because flattening corrupts real repos in a way git reports
as a mode change, and safety is achievable by validating instead of destroying information.
That decision supersedes the open question in 2b.
Must land BEFORE the gym milestone: "the agent did the work" is worthless if the result
cannot be extracted and verified.
