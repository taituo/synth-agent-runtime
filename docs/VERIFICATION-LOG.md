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

## Round-six scorer forgery fix: the in-process signer is gone (2026-09-20)

Review round six ONE-a executed the signing oracle against main `bf56bca`: the
HMAC harness was written into the clone and exported `check()`/`complete()`, so
agent code signed a forged transcript with the real per-run key and scored
`passed` with the bug unfixed. Reproduced on the committed dist before the fix
(`/tmp/opencode/audit6/attack-main-hmac-v2.mjs`), then re-run against the ported
isolated verifier:

| state | signing-oracle payload | guessed-MAC control |
|---|---|---|
| `bf56bca` (before) | `passed` (bug unfixed) | `errored` |
| isolated verifier (after) | `errored` | `errored` |

Failing-first: `test/gym-vacuity.test.ts` "FORGE 4 (round six ONE-a)" is the
permanent regression, and it can fail for the real reason — restoring an
in-clone `gym-hidden-harness.mjs` that exports the signer makes the payload
`passed` again. The scorer no longer runs a signer in the agent's process: the
verifier holds the held-out vectors and the worker only reports raw return
values, so the oracle has nothing to call. FORGE 5/5b (held-out vectors read off
disk and via `/proc/<ppid>/cwd`) are pinned too; the worker runs under Node's
permission model confined to the scoring work dir and refuses to run if the
model is unavailable. `scoreGymPatch` now takes held-out `cases` instead of a
`hiddenTestPath`; the `he/decimal-option` fixture ships `hidden.cases.json`.

Follow-up on the same commit: a legacy-shaped call (`hiddenTestPath` plus
`expectedHiddenTests`, no `cases`) reached `options.cases.length` and threw
`TypeError: cannot read properties of undefined`, breaking the rule that the
scorer returns an outcome rather than throwing (the same class as the
hidden-test-dest-as-a-directory crash). `isolatedScoreGymPatch` now checks
`Array.isArray(options.cases)` and returns `errored` with a clear detail.
Failing-first: `test/gym-scoring.test.ts` "a legacy hiddenTestPath call is
errored, not a crash" failed with `TypeError` before the guard and passes after.

## Round-six survivor: a leaf symlink reached the held-out vectors (2026-09-20)

The permission model denied direct reads and `process.getBuiltinModule` reads
(ERR_ACCESS_DENIED), and the signing-oracle class was closed. One payload
survived: the patch planted `escape.json` as a symlink to the held-out vectors
file, and the worker read it. Node follows the link before the permission
decision, so an allowlisted path can still reach outside. Reproduced first as a
failing regression (`FORGE 6`, `test/gym-vacuity.test.ts`): `passed` 4 of 4 with
the bug unfixed before the guard.

Fix: `findEscapingSymlink` walks the applied checkout and resolves every
symlink's real path; any link that escapes the checkout (or is broken) makes the
score `tampered` before the worker starts. A patch cannot create a link at
runtime either, since the worker has no write permission.

Re-ran the reviewer's full battery (`/tmp/opencode/audit6/oracle-battery-885.mjs`,
adapted to this build): golden control `passed` 4/4; all six attack payloads not
passed — five `failed`/`errored`, the symlink variant `tampered` with 0 passed
cases. `FORGE 6` is the permanent regression for the survivor.

## Follow-up on the symlink fix: surface and model check (ff7ab93)

Reviewer channel inventory. What was checked, not a conclusion:

- The fix is a checkout scan (`findEscapingSymlink`), not a guard on one fs
  function. A patch-planted leaf symlink was refused (`tampered`, 0 passed
  cases) whether the agent read it with `readFileSync`, `openSync`+`readSync`,
  or `statSync`/`accessSync`/`realpathSync` — the patch never reaches the
  worker, so the primitive is irrelevant.
- The Node permission model is still in force and was not replaced by a
  preload/realpath check: `permissionArgs` still returns
  `--permission --allow-fs-read=<work>` and the worker is spawned with it
  (`src/gym/scoring.ts:228,333`); there is no `--import`, no `NODE_OPTIONS`.
  Confirmed by running payloads that would reopen if the model were gone
  (`/tmp/opencode/audit6/followup-ff7ab93.mjs`): direct `fs.readFileSync`,
  `require`, dynamic `import`, `new Worker`, `module.register` and
  `child_process.execFileSync` all returned `ERR_ACCESS_DENIED` (module loader:
  "Access to this API has been restricted"); `fetch("file://…")` failed
  ("fetch failed"). GOLDEN control passed 2/2.
- Permanent regressions added: `FORGE 6b` (symlink via `openSync`/`readSync` is
  `tampered`) and `FORGE 7` (`require` of the vectors is denied). `FORGE 5`
  already pins the direct-read denial.

## Node permission model does not gate node:sqlite (2026-09-20)

Reviewer finding: `node:sqlite` is NOT covered by Node's permission model. The
worker, confined by `--permission --allow-fs-read=<work>`, could still open and
mutate SQLite databases anywhere writable — a host-integrity escape independent
of the verdict, and a latent forgery channel if expected values were ever stored
in a SQLite file.

Measured on this runtime: `node:sqlite` is available by default; with
`--no-experimental-sqlite`, `require("node:sqlite")` fails with
`ERR_UNKNOWN_BUILTIN_MODULE`.

Fix: `workerArgs` adds an explicit `node:sqlite` deny. It probes whether the
runtime exposes `node:sqlite` and whether `--no-experimental-sqlite` is
accepted; if sqlite is present and cannot be denied, the scorer refuses to run
rather than fail open.

Failing-first: `FORGE 8` (worker opens and mutates a host DB outside the work
dir) — without the deny, the host database file is created and the test fails on
`the host database must not be created`; with the deny, the file is absent and
the module reports `ERR_UNKNOWN_BUILTIN_MODULE`.

Wording corrected: the confinement is a guardrail, not a security boundary
(Node documents the model as such). Real isolation needs an OS sandbox; recorded
in docs/KNOWN-OPEN.md.
