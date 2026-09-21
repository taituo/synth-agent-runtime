# Three follow-ups after the test-suite work

Repo: /home/tiny/projects/pisynth/synth-agent-runtime. Work here, push to origin/main.
Same discipline as before: failing-first evidence for every new test, full suite green,
live proof not a mock, one item at a time, commit each separately.

## 1 (main): an activity returning `state: "waiting"` spins the workflow hot

`RunTurnResult.state` legally allows `"waiting"` (src/contracts.ts). When an activity
returns it while the mailbox is non-empty, `durableAgentWorkflow` does this:

- `state.status = result.state` → `"waiting"`;
- the mailbox is NOT spliced, because `workflows.ts` splices only when the status is `"idle"`;
- `parkAttempt` is reset to 0, so no backoff applies (that path is only in the `catch`);
- the loop's `await condition(() => wake || cancelled || state.mailbox.length > 0)` returns
  IMMEDIATELY, because the mailbox is still non-empty.

Result: the same turn re-runs continuously with zero delay.

MEASURED, on the current HEAD, against the live dev server (my probe, not a guess):
**59 activity calls in 5 seconds (12.2 calls/second)**, mailbox stuck at length 1, status
stuck at `running`. Workflow history grows at that rate until Temporal kills the workflow.

Why the suite missed it — this is the important part, and it is a coverage lesson, not a
one-off: EVERY driver and test in this repo hardcodes the activity's return state. Across
all eight return sites (`event-runner.ts`, `interceptors-live.ts`, `mailbox-property-driver.ts`,
`phase-signals-driver.ts`, `park-live.ts`) only `"idle"` and `"completed"` are ever returned.
Inputs are fuzzed thoroughly; the activity's RETURN VALUE is never fuzzed. A whole dimension
of the contract is untested.

Do this:
1. Write the failing test FIRST: a live proof that an activity returning `"waiting"` with a
   non-empty mailbox does not spin. Assert a BOUND on activity calls (e.g. at most a couple
   within several seconds), not just the final status — a status assertion would pass on the
   spinning code. Confirm it fails on current HEAD, and record the numbers.
2. Then decide and implement the semantics, and write down the reasoning in docs/TEMPORAL.md:
   either `"waiting"` from an activity means "park me" (then it must use the same backoff
   path as a transient failure), or it is not a legal thing for an activity to return (then
   reject it loudly and remove it from the `RunTurnResult` type). Pick one, argue it in one
   paragraph. Do NOT leave a third state that silently spins.
3. Extend Track 3's generator to fuzz the activity's returned state as well as the messages,
   so this class of bug is reachable by the property check in future. That is the real fix.

## 2: the corpus ground truth is wrong, not the model

All four corpus mismatches are CVE items the model calls `news` while we label them
`incident`. The triage prompt defines `incident` as "an operational alert about a system
failure or degradation that needs action". A CVE description is a published vulnerability
report, not an alert about our system degrading — so by our own definition the model is
right and the labels are wrong. Right now the 0.6 gate mostly measures how well the model
guesses our mistakes.

Relabel the CVE items to `news` (or, if you disagree, widen the prompt's `incident`
definition to cover security advisories — but then say so in the prompt, not only in a
comment). Re-measure the baseline on the live model, and set the gate from the NEW measured
number with the date. Do not keep a gate that is tuned to absorb a labelling error.

## 3: no UNPROVEN rows in the fault matrix

`two-workers-race` (lease/fencing) is listed in the matrix but was never executed, and
`clock-jump` is marked NOT COVERED. Also, `test/fault-matrix.test.ts` asserts
`row.differentiates === (row.category === "executor")`, which only checks that one
hand-written field matches another hand-written field — it proves nothing about behaviour.

Either run a row or delete it:
- `two-workers-race`: the repo HAS leases and fencing tokens, so this is testable. Write the
  live proof (two workers, one agent, the fenced one must lose) and fill the row with real
  values.
- `clock-jump`: if there is genuinely no injectable clock, remove the row from the matrix and
  keep it only in the "not covered" list. A matrix row is a claim; a claim with no evidence
  does not belong in the deliverable.
- Replace the circular assertion with one that checks each row against its cited evidence
  artifact, or drop that test — a test that cannot fail for a real reason is worse than none.

## Report back
What failed before each fix (with numbers), what passes now, and the commit SHAs.
