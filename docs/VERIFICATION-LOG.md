# Failing-first verification log

The standing rule is that a new test must be able to fail for the reason it
claims. For each change below, the thing the test covers was deliberately broken
(the mutation), the failure was observed, and the code was restored. This file
exists because a claim of "failing-first" without a recorded failure is not
evidence.

Rows added by later work should be appended, not rewritten. Each row names the
commit that carries the test, the mutation, and the observed failure text.

## 2026-09-20

| commit | mutation (what was broken) | observed failure | restored |
|---|---|---|---|
| `4402de2` | neutralise `isTampering` (always false) | gym tests 4, 5 (`tampered` expected) failed | 7/7 |
| `4402de2` | map `timedOut` to `passed` | gym test 7 (`timed-out`) failed | 7/7 |
| `4402de2` | score against the visible test instead of the held-out one | gym test 3: the constant stub wrongly `passed` | 7/7 |
| `4402de2` | delete `env.NODE_TEST_CONTEXT` in the runner | gym tests 2, 3, 10 failed under node22 (round-3 reviewer independently reproduced) | 7/7 |
| `7c032b9` | restore the `modelIds` filter in `listModels()` | adapter tests 1, 2 failed (only one model listed; no `provider`) | 3/3 |
| `f7d1241` | restore the old exit-code-only outcome mapping and drop the preload/nonce | gym tests 4, 6, 7 failed with `actual: 'passed'` where not-passed was expected | 15/15 |
| `7d0b133` | remove the expired-ticket filter in `#takeNext()` | lane test 11 and the property test failed: `trial 0: t14 waited 45ms, lane allows 36ms` | 13/13 |
| `83daa45` | rewrite `two-workers-race` evidence to nonsense and its artifact to a `.test.ts` | fault-matrix test 1 failed: `two-workers-race: proven evidence must record an executed run` | 6/6 |
| `ec0cd9d` | make `honoursRetryHint` return `true` unconditionally | park-tracking tests 2, 3 failed | 3/3 |
| `d8bb6b9` | make the broker return an `EffectResult.artifact` | blob-store "KNOWN OPEN" canary failed | 6/6 |

## Notes

- `4402de2`'s mutations were executed before this log existed; they are recorded
  here from the session checkpoint and the round-3 review's independent
  reproduction, and the tests remain in `test/gym-scoring.test.ts`.
- `7bf70e6` (retry-hint consolidation) needed no mutation: the existing twelve
  `retry-hints.test.ts` cases are the unchanged-behaviour proof, and the new
  parity test pins the canonical and stack-router copies to each other.
- The `d8bb6b9` canary is a deliberate inverse: it asserts the known-open gap
  (`EffectResult.artifact` is never populated), so it fails the day a writer
  lands and the known-open entry must be removed on purpose.

## Solidification rounds on the gym scorer (real repo + fuzz)

These rounds add no features; they pin the scorer on a real pinned repo and
fuzz the two places the round-3 review attacked.

| test | what it pins | how it can fail |
|---|---|---|
| `test/gym-real-task.test.ts` round 1 | the held-out test FAILS on the materialized `he` bug and PASSES once fixed | run the hidden test directly on each checkout; a vacuous hidden test would return 0 on both |
| `test/gym-real-task.test.ts` round 2 | golden reverse patch `passed`; partial fix `failed`; visible-test edit `tampered`; top-level `exit(0)` not `passed`; bad patch `errored` | score each real patch through `scoreGymPatch` |
| `test/gym-patch-paths.test.ts` | 200 seeded patch shapes: every path git touches is in `patchTargetPaths`, both rename sides are exposed, protected paths are flagged | differential against `git apply --numstat -z` |
| `test/gym-vacuity.test.ts` | a hidden test with no marker or a guessed marker is `errored`; agent-printed forged marker does not rescue a failing test; real marker + correct fix `passed` | each shape scored through `scoreGymPatch` |

The real-task round immediately caught a bug in the round's own helper: it
inherited `NODE_TEST_CONTEXT` from the outer `node --test`, so the child skipped
every file and exited 0 — the same false-pass the scorer strips. The round-1
assertion (the hidden test must FAIL on the bugged repo) is what exposed it;
the helper now strips the variable. That is the discipline working: the test
was able to fail for the reason it claimed.

The patch-path fuzz's first run failed on an over-strict assertion (a rename may
pick the same old and new name), not on the implementation; the assertion now
checks both rename sides only when they differ.
