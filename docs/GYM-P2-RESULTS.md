# Gym P2 — live results (one task, both arms, fault matrix)

Task `he/hex-decode`, model `kimi-k2.7-code`, gateway `http://127.0.0.1:8791`.
maxTurns 8, one attempt per arm, runner `local` for both arms so the only
variable is durability. Faults were run **one at a time** (memory-constrained
box); this file is committed after each fault so a mid-matrix death costs one
fault, not the run.

## Runner — read this before the numbers

**Every row in this file was produced with `runner local` for both arms.** The
model-authored code executed on the host checkout with no isolation: the agent's
`run_visible_test` ran the host node against the host files, and the sandbox
runner was not in the agent path at all. Node's permission model is in the
*scorer* (which re-runs the agent's patch in a confined worker), not in the agent
execution path. The comparison is still a valid **durability** comparison —
both arms used the identical local runner, so the only variable was durability —
but it is **not** evidence that agent code ran sandboxed, and no isolation claim
may be read from it.

The sandbox runner was in fact broken for the whole matrix: `run_visible_test`
invoked a host node path the Pod cannot see (exit 127), and the Pod's git refused
the control-plane-materialized workspace ("detected dubious ownership"). It is
now fixed and proven live at zero model cost by
`integrations/gym/sandbox-live.ts` (gVisor uname, Pod node, Pod git, and the
agent's edit executed by the Pod's node). The image must contain **both node and
git**; the proof pins
`docker.io/library/node:22-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844`.
A git-only image such as `alpine/git` has no `node`, which is the exit 127 — that
is the mistake to avoid. **No matrix row has been re-run under the sandbox
runner**; a sandbox-run matrix is a separate, unmeasured configuration. The
`runner` column below records the runner that produced each row.

## Part ONE — one real attempt per arm

| arm | outcome | model calls | turns | wall | patch |
|---|---|---|---|---|---|
| plain | passed | 4 | 4 | 35.5 s | 358 B |
| durable | passed | 4 | 4 | 41.1 s | 358 B |

Identical 358-byte patches; the arms differ only in durability. Runner `local`
for both arms (host, no sandbox).

## Part TWO — fault matrix

Run one fault at a time; each row is committed as it completes.

### Rows 1–2 (final)

| # | fault | runner | plain arm | durable arm | differentiated |
|---|---|---|---|---|---|
| 1 | 502 (first request) | local | errored, 1 call, 28 ms | passed, 8 calls, 39.5 s, 358 B | **yes** |
| 2 | 429 + `Retry-After` x3 | local | errored, 1 call, 31 ms | passed, 8 calls, 65.7 s, 358 B | **yes** |

**Interpretation — rows 1–2 are retry-policy rows, not durability evidence.**
The plain arm in these runs was a no-retry single shot (`createGatewayGymTurn`
threw on the first non-2xx and `runPlainOnce` called the loop once); the durable
arm got Temporal's activity retry plus the workflow's park/backoff. So these rows
measure "has any retry at all", which a plain HTTP client can have without
Temporal, leases or receipts. The durability evidence is the process-fault rows
(worker restart, SIGKILL), where the plain child vanishes and the durable
workflow survives — a difference in kind, not degree.

**The fair control is implemented and the matrix has been re-run with it** (see
the fair-control section below). `createGatewayGymTurn` takes a bounded transient
retry (`DEFAULT_GATEWAY_RETRY`: 3 attempts, exponential backoff, `Retry-After`
honoured and capped), and both drivers take `--retry <n>` so the plain arm and
the durable arm's activity run the *same* retry configuration — the arms then
differ only in durability. The numbers above describe the single-shot plain arm;
the fair-control re-run below supersedes their differentiation verdicts. The
turn-level behaviour is pinned by
`test/gym-turn.test.ts` (retries 502/429/network, honours `Retry-After`, does not
retry 4xx or malformed replies) and the accounting by `test/gym-attempt.test.ts`
(`httpAttempts` separates in-turn retries from model turns).

### Rows 3–4 as first run (confounded — superseded by the re-run below)

| # | fault | plain arm | durable arm | verdict |
|---|---|---|---|---|
| 3 | timeout (hung request) | errored, 1 call, 20.0 s | errored, 2 calls, 14.3 s | **SAME** — both errored |
| 4 | worker restart (SIGTERM) | **lost** — child killed, run vanished, no result | **resumed** — task continued on the restarted worker (3 calls), then errored | difference in kind (lost vs resumed); neither passed |

Fault 3: the durable arm did retry past the hang, but the surviving attempt then
failed on a malformed/truncated reply and errored — identical end outcome to
plain. Fault 4: the durable workflow genuinely survived the SIGTERM and ran
three calls on the restarted worker, while the plain arm produced no result at
all; lost versus resumed is a difference in kind, but the resumed attempt then
hit the same malformed reply, so neither arm passed.

### Design decision: is a malformed reply transient?

The first runs classified a malformed/truncated reply as non-retryable, so one
bad reply ended the attempt. The question is genuinely open: the failure is
stochastic (resampling often yields valid JSON), which argues for retrying, but
a model that reliably emits bad JSON would then burn the durable retry budget
every turn and the attempt could never succeed.

Decision: a malformed reply is **re-asked exactly once in-loop** (`maxReasks`,
default 1), on a budget **separate** from the transient path. It is classified
`malformed`, not `transient`, so the durable activity does not hand it to
Temporal's retry/park machinery. This buys recovery from a stochastic slip
without letting a broken model consume the durability allowance. Failures this
makes unrecoverable: a second malformed reply in the same attempt, and any
non-provider, non-JSON error. Pinned by tests:
`a malformed reply is re-asked once, then fatal...` and
`a single stochastic malformed reply recovers after the re-ask`
(`test/gym-attempt.test.ts`).

### Confound finding (independent of the matrix)

`kimi-k2.7-code` emitted malformed/truncated JSON often enough to mask two
consecutive matrix rows. The truncation is consistent with the `max_tokens:
4096` cap cutting a long tool-call payload (the model sometimes chooses
`write_file` with the whole ~30 KB file rather than `replace_in_file`). A cheap
code model can thus produce protocol-level failures at a rate that dominates a
small experiment; the harness must budget for that rather than assume every
failure is the injected fault.

### Rows 3–5 re-run on the fixed classification

| # | fault | runner | plain arm | durable arm | differentiated |
|---|---|---|---|---|---|
| 3 | timeout (hung request) | local | errored, 1 call, 20.0 s | passed, 6 calls, 27.9 s, 358 B, recovered | **yes** |
| 4 | worker restart (SIGTERM) | local | **lost** — child killed, no result | **resumed**, passed, 4 calls, 22.0 s, 358 B, recovered | **yes** |
| 5a | SIGKILL mid-turn | local | **lost** — child killed, no result | **resumed** (8 calls, 106.0 s), then **failed** — no change, 0 B | resumed vs vanished, **not a pass** |
| 5b | SIGKILL mid-turn | local | lost | resumed, passed, 8 calls, 111.7 s, 358 B, recovered | yes |
| 5c | SIGKILL (instrumented) | local | lost | resumed, passed, 6 calls, 50.2 s, 358 B; **activity attempt=2** | yes |

SIGKILL completed in four durable samples: three passed (358 B), one produced
0 B (5a). Two further diagnostic runs died (5d: harness exit 1 with stderr lost;
5e: hung past a 700 s limit and was killed). Both deaths were the harness/box,
not a durable outcome, and both were cleaned up. The harness is now fixed to
kill its worker in a `finally`; it still needs a bounded `handle.result()`.

### Architectural finding: control-plane durability is not work-product durability

The instrumented SIGKILL run proves the mechanism behind 5a's 0 B. The execution
that produced the result is stamped:

```
0 activity attempt=2 startedAt=2026-09-20T11:01:54.743Z
3 assistant: read_file(he.js)
4 tool read_file(he.js): workspace=BUGGED
5 assistant: replace_in_file(...)
...
11 assistant: finish
```

`attempt=2` means the traced run is the retry after the SIGKILL, and its first
`read_file` sees the **bugged** source at turn 0. The workspace is re-materialized
by `materializeGymTask` on every activity execution, so any edits the killed
attempt had made are gone: the retry redoes the whole task from the base. This is
the expected behaviour of the current design, but it means the runtime gives
**control-plane** durability (the workflow and its task survive the worker) and
not **work-product** durability (the edits in the workspace survive). The 0 B
sample is the visible cost: the resumed attempt can spend its budget and still
produce nothing, because it starts over.

Correction to the hypothesis that motivated this check: the turn budget is **not**
already spent on resume. `maxTurns` is an activity input and resets to 8 on the
retried execution — the trace starts at turn 0 and the passing samples used 4–8
turns. So 5a is not "budget exhausted by the earlier attempt"; it is a fresh
from-scratch attempt in which the model made no net edit. What is lost is the
workspace, not the budget.

Fix direction (not built here): checkpoint the work product — workspace overlay
or harvested patch — to the artifact store between turns (or at least at activity
attempt boundaries) and resume the workspace with the retry instead of
re-materializing from the pinned bugged commit.

### SIGKILL after the work-product checkpoint fix (4 samples, same params)

The fix: `src/gym/checkpoint.ts` + `runGymAttempt` resume. Each sample is a
fresh workflow key; kill-after 12 s; maxTurns 8. `resumedFromTurn` is the turn
the retried activity continued from.

| sample | plain | durable | calls | resumedFrom | patch |
|---|---|---|---|---|---|
| 1 | lost | **passed** | 2 | 2 | 358 B |
| 2 | lost | **passed** | 6 | 1 | 358 B |
| 3 | lost | **passed** | 5 | 2 | 358 B |
| 4 | lost | **run died** | — | — | — |

With the checkpoint fix, the three completed SIGKILL samples all passed (the
pre-fix result was 3 passes in 4, with one 0 B failure). Sample 4 died on the
sigkill fault — the harness process was killed by the 700 s tool timeout while
`handle.result()` blocked; no durable outcome was produced, and its worker was
cleaned up. So the "4/4" question is not fully answered: 3 of 3 completed
samples passed and the 0 B case did not recur, but the fourth sample is a box
death, not a durable result. These passes carry the same narrower interpretation
as below: they show pre-kill work is re-applied, not that the fix was
re-derived after resume.

Caveat on certification: samples 1–3 were scored before the fifth-round scorer
fix, i.e. their `passed` came from the legacy in-process scorer. The traces show
real work (`read_file` -> `replace_in_file` -> `finish`, 358 B canonical diff),
but under the fifth-round finding a `passed` from that scorer is not a
certification. A clean re-run of the SIGKILL samples under the isolated scorer
(`src/gym/scoring.ts`) is the remaining measurement.

## Re-score of recorded patches under the isolated scorer (zero model calls)

Every stored per-turn checkpoint patch from the checkpoint-era runs was re-scored
with `isolatedScoreGymPatch` against the real `he` task, plus the canonical
minimal patch and an empty no-op as controls:

| patch source | patch bytes | isolated verdict |
|---|---|---|
| stored checkpoint `…mfsu` (turn 3) | 358 | passed |
| stored checkpoint `…rewh` (turn 6) | 358 | passed |
| stored checkpoint `…v6zy` (turn 6) | 358 | passed |
| stored checkpoint `…xamo` (turn 4) | 0 | failed |
| stored checkpoint `…kebx` (turn 4) | 358 | passed |
| canonical minimal fix | 358 | passed |
| empty no-op | 0 | failed |

No previously-passed row changes verdict. The stored 0 B checkpoint is the 0 B
SIGKILL sample and remains `failed`, exactly as it was originally recorded, so
the re-score is discriminating rather than uniformly green. Passing rows whose
final patch was not persisted (the pre-checkpoint 502/429/timeout/worker-restart
rows) all recorded exactly 358 bytes, and this task has a unique deterministic
minimal diff (the reviewer measured the golden at 358 bytes); that patch passes
the isolated scorer. The matrix therefore stands on the unforgeable scorer.

## SIGKILL under the isolated scorer (fresh 4 samples)

After the zero-cost re-score showed no verdict change, the same SIGKILL run was
repeated with the hardened scorer and the bounded-wait/logging harness.

| sample | plain | durable | calls | resumedFrom | patch |
|---|---|---|---|---|---|
| 1 | lost | **passed** | 3 | 2 | 358 B |
| 2 | lost | **passed** | 6 | 2 | 358 B |
| 3 | lost | **passed** | 3 | 2 | 358 B |
| 4 | lost | **passed** | 7 | 1 | 358 B |

All four samples passed under the isolated scorer and the 0-byte case did not
recur (the pre-fix baseline was 3 passes in 4 with one 0 B). **Interpretation,
narrower than the headline:** a checkpoint can already contain the finished fix
at the kill point, so these passes demonstrate that work produced before the kill
is not lost and is re-applied on resume — not that the resumed agent re-derived
the fix. A resumed attempt that merely calls `finish` can score `passed`, and the
`resumedFromTurn 1-2` column is consistent with exactly that. The stronger
property — that the resumed attempt makes new edits rather than only replaying —
is measured deterministically at zero model cost by `stronger claim: with a
non-fixing checkpoint the resumed attempt must make the edit` in
`test/gym-checkpoint.test.ts`: it checkpoints a partial, non-fixing edit, asserts
the fix is absent before the resumed turn, and requires that turn to produce the
final patch. It passes.

### What killed the earlier sample 4

Not reproducible. The earlier checkpoint-batch sample 4 hung past the 700 s tool
timeout and left an orphaned worker; the harness had no bound on
`handle.result()` and no worker logging, so the hang could not be diagnosed from
its own artifacts. Its environment (about 550 MB free before the run) makes
worker loss under memory pressure the most likely cause: if the restarted worker
dies, the workflow never completes and an unbounded wait blocks forever. The
harness now bounds that wait (`--result-timeout-ms`) and captures the worker log,
which turns that class into a diagnosable `harness-timeout` result instead of a
silent harness death. The re-run of sample 4 passed cleanly in 1m48s with no
worker-level error in its log.

## Fair-control re-run — all five faults with `--retry 3` (2026-09-20)

The plain arm is now given the same bounded transient retry as the durable arm's
activity (`--retry 3` on both, `DEFAULT_GATEWAY_RETRY`), so the arms differ only
in durability. Model `kimi-k2.7-code`, gateway `http://127.0.0.1:8791`, Temporal
`127.0.0.1:7233`, current isolated scorer, **runner `local` for both arms (host,
no sandbox)**. Each cell is `outcome, model turns (HTTP attempts), wall, patch`.

| # | fault | runner | OLD plain (single-shot) | OLD durable | old diff | NEW plain (`--retry 3`) | NEW durable (`--retry 3`) | new diff |
|---|---|---|---|---|---|---|---|---|
| 1 | 502 (first request) | local | errored, 1 call, 28 ms | passed, 8 calls, 39.5 s, 358 B | yes | passed, 5 (6), 35.1 s, 358 B | passed, 6 (7), 37.6 s, 358 B | **no** |
| 2 | 429 + `Retry-After` x3 | local | errored, 1 call, 31 ms | passed, 8 calls, 65.7 s, 358 B | yes | errored, 1 (3), 2.0 s, 0 B | passed, 8 (9), 84.4 s, 358 B, **activity attempt=2** | yes |
| 3 | timeout (hung request) | local | errored, 1 call, 20.0 s | passed, 6 calls, 27.9 s, 358 B | yes | passed, 5 (6), 57.8 s, 358 B | passed, 5 (6), 46.4 s, 358 B | **no** |
| 4 | worker restart (SIGTERM) | local | **lost** — killed, no result | resumed, passed, 4 calls, 22.0 s, 358 B | yes | **lost** — SIGTERM, exit 143, no result | passed, 6 calls, 32.5 s, 358 B (one activity execution) | yes |
| 5 | SIGKILL mid-turn | local | **lost** — killed, no result | resumed, passed, 8 calls, 111.7 s, 358 B | yes | **lost** — SIGKILL, no result | passed, 3 calls, 18.9 s, 358 B, **resumedFromTurn 1** (two activity executions) | yes |

**Which faults stopped differentiating.** Two of the three retry-policy faults
did: **502** and **timeout** now pass on both arms, so those rows were never
durability evidence — they measured "has any retry at all", and a plain client
with backoff has that without a runtime.

**429 did not stop differentiating, but it is not durability either.** The
scenario injects three consecutive 429s (`failFirst: 3`), which is exactly the
plain arm's three-attempt budget, so the plain arm exhausts and errors; the
durable arm recovers on a **second activity invocation** (`activity attempt=2`),
i.e. a retry at a higher level, not process-death recovery. Sensitivity check:
`--fault 429 --retry 4 --arm plain` → plain **passed** (5 calls, 8 HTTP attempts,
32.3 s, 358 B). So row 2 measures retry *budget/level*: match the budget and the
difference disappears. It is not evidence that durability is required.

**What remains is the process-death class.** For **worker restart (SIGTERM)** and
**SIGKILL**, the plain arm is killed with no result, and no retry can help because
the process holding the state is gone. The durable arm passes both. The two
mechanisms differ and are worth distinguishing:

- SIGTERM (row 4): one activity execution completed — the Temporal worker drained
  the in-flight activity on the signal rather than being retried. Plain has no
  drain, so it is lost; durable survives by graceful shutdown.
- SIGKILL (row 5): the workflow history shows **two activity executions**; the
  second resumed at turn 1 from the work-product checkpoint
  (`resumedFromTurn: 1`) and passed. This is the strongest form: state lost with
  the process is restored by the runtime, which no in-process retry can do.

**Net claim, sharper than before:** retry is not durability. Under a matched
retry budget, transient provider faults (502, timeout, and 429 once the budget is
matched) do not differentiate the arms; the only faults that require the durable
runtime are process death (SIGTERM, SIGKILL), where the work product survives in
the checkpoint and is resumed by a new process.
