# Verification

How this repo's claims are verified, how to run the verification set, and the
permanent regression test behind each demonstrated attack. Adversarial findings
live here and in the tests, not in a scratch directory that a reboot loses.

## The standard

These are the rules that were learned the hard way; the rest of `STANDING-ORDERS`
is scoutcraft, but these govern evidence:

1. **Attack it; do not read its tests.** An anti-cheat or security claim is
   verified by attempting the attack, not by reading test names.
2. **Run the control.** A check that only ever rejects is not evidence; the
   legitimate path must still pass.
3. **Every demonstrated attack becomes a permanent regression test.** Otherwise
   a redesign reopens the hole through the channel it did not consider.
4. **Check the call path, not just that code exists.** Grep for callers; a
   component accepted as wired when nothing calls it is not wired.
5. **Assert the discriminating quantity** — call counts, timing, sizes — not a
   status. A status assertion usually passes on the broken code too.
6. **A skip is never `ok: true`.** A skipped check is exit code 2, distinct from
   success (0) and failure (1), and it never counts as a pass.
7. **No claim without an executed artifact.** A results table row with no run
   behind it is a defect.
8. **Verify the committed state in a clean tree.** Build from source with
   `rm -rf dist` first (the `build`/`test` scripts now do this); stale compiled
   tests have produced both false greens and false alarms.
9. **Say when a result does not differentiate**, or when a fix does not help.
   Never tune the measure until the answer flatters the system.
10. **Full suites green and a secret scan before a push.** Never commit
    `integrations/*/dist/`.

## How to run

```bash
npm run verify                  # root + Temporal suites, syntax, secret scan,
                                # and the Temporal live proofs; exit 0/1/2
node scripts/verify.mjs --all-live   # also run every live proof (many skip)
node scripts/live-proofs.mjs --only=graph-restart   # one proof
node scripts/live-proofs.mjs --json                 # machine-readable summary
npm run scorer:isolation-probe                       # scorer capability inventory
```

Exit codes are the skip contract: `0` all selected checks passed, `1` a check
failed, `2` a check was skipped. `scripts/live-proofs.mjs` and
`scripts/verify.mjs` both exit `2` on a skip-only run; `scripts/live-proof.mjs`
already did (a skip is never a pass).

## Demonstrated attacks and their permanent regression tests

| Attack (who found it) | Permanent regression test |
|---|---|
| A gym patch makes the visible test green without fixing the bug: `process.exit(0)` at import, monkeypatching `assert`, a constant stub | `test/gym-scoring.test.ts` (the three cheat cases); control: "a correct fix passes the held-out vectors" |
| Gym forgery via the env nonce, an early exit, an assert mutation, or importing an in-scorer signer | `test/gym-forge.test.ts` FORGE 1–4 |
| Reading the held-out vectors off the filesystem, or via `/proc/<ppid>/cwd` | `test/gym-forge.test.ts` FORGE 5, 5b |
| A leaf symlink to the vectors, an intermediate-directory symlink, `require`, `node:sqlite` | `test/gym-forge.test.ts` FORGE 6, 7, 8, 9 |
| Tampering hidden as a patch path trick (no `diff --git` header, rename, non-ASCII, `./` prefix, `tests/` dir) | `test/gym-scoring.test.ts`; fuzz `test/gym-patch-paths.test.ts` |
| Scorer worker reaching host services/state (TCP, unix socket, `process.kill`, `os.userInfo`) | `scripts/scorer-isolation-probe.mjs` (live; exit 2 while any class is reachable) + `docs/KNOWN-OPEN.md` |
| Symlink escape on the workspace path: absolute target, chain, intermediate symlinked dir, dangling link, legitimate relative in-repo link | `test/symlink-target.test.ts` |
| The synthetic rung silently rewrites an escaping path; the parity oracle importing the implementation | `test/rung-parity.test.ts` (`../`, absolute, oracle-independence, source-backed symlink read) |
| Cross-tenant blob read; blob dedup/corruption | `test/blob-access.test.ts`, `test/blob-store.test.ts` |
| Git option injection through a workspace `ref`/`remote` | `test/native-git-source-security.test.ts` |
| Pushing beyond a one-shot scoped grant (extra ref, consumed/expired grant, `--no-verify`) | `test/scoped-push.test.ts` |
| Lane scheduler admits a request past its deadline through `release()`; unknown lane gets a 1 ms deadline | `test/lane-scheduler.test.ts` ("release never admits…" + property), `test/lane-policy.test.ts` |
| A stale agent writer publishes after a newer fencing generation | `test/postgres-control.test.ts`; live `integrations/postgres/concurrency.ts` (`postgres-live.yml`) |
| The scored-rung guard was exported but had no caller (verify-9) | `integrations/temporal/test/gateway-run-turn.test.ts` (refused on the production path + unscored/isolated controls) |
| An effect re-executed when a Temporal activity retries | `integrations/temporal/test/gateway-run-turn.test.ts` (dedupe + heartbeat-details round-trip); live `effect-receipt` |
| `continueAsNew` re-ran the graph from the start and never resumed | `integrations/temporal/test/graph.test.ts` (resume without re-running journaled nodes); live `graph-continue-as-new` |
| A provider hardwired to opencode, or not selected by config | `test/provider-config.test.ts` |
| The scoring worker escaping its jail: TCP to Temporal/Postgres, a host unix-socket bind, signalling the verifier, reading host `userInfo` (external review risk #1) | `scripts/scorer-isolation-probe.mjs` — host-effect-aware, red on the host worker and green in the gVisor pod; `test/gym-scoring-hardening.test.ts` (boundary selection + refusal) |
| A credential committed to the git index | `test/secret-scan.test.ts` |
| A driver "passing" because it skipped everything | `test/driver-skips.test.ts`; exit-2 semantics in `scripts/live-proofs.mjs` / `scripts/verify.mjs` |

The control for each family is in the same file (a legitimate fix still passes,
an in-workspace symlink is kept, a committed effect replays, the golden patch
scores `passed`).

## Live proofs

Run one with `node scripts/live-proofs.mjs --only=<name>`; `requires` is
preflighted so missing infra is an honest skip. The discriminating quantity is
what the proof asserts.

| proof | requires | discriminating quantity |
|---|---|---|
| `graph-restart` | temporal | per-node call counts `pre=1 iter=3 left=1 right=1 hang=2` after a SIGKILL; committed nodes not re-run |
| `durable-restart` | temporal | committed turn `committedCalls=1`, in-flight turn retried |
| `graph-child` | temporal | parent history has a `StartChildWorkflowExecutionInitiated` for `runGraphWorkflow` with a distinct child run id; parent result embeds the child's state |
| `graph-continue-as-new` | temporal | one `WorkflowExecutionContinuedAsNew`, final run completes with exactly 1100 iterations and no duplicates |
| `graph-cancel` | temporal | the loop counter stops (3 at cancel, 3 after return) |
| `effect-receipt` | temporal | attempts `[1,2]`, attempt 2 seeds `write_file:0=committed`, the first effect executed exactly once |
| `observability` | temporal+k8s+gvisor | `agentId`-filtered query returns the run and decodes its attributes; the Prometheus scrape has the native + custom series; the span chain `synth.sandbox.exec → synth.effect.execute → synth.engine.run → RunActivity → RunWorkflow → StartWorkflow`; a log line carries workflowId/runId/activityId/agentId/rung |
| `sandbox-workspace` | k8s+gvisor | workspace effects execute in the Pod (executor id, pod bytes), host untouched |
| `mixed-chain` | k8s+gvisor | executor/fidelity per effect across the rung boundary; committed replays, started stays uncertain |
| `postgres-concurrency` | postgres | multi-worker concurrency + hard fencing (also run by `postgres-live.yml`) |

`scripts/live-proofs.mjs --list` shows every proof and its requirement. A few
proofs additionally need a gateway, model quota, tmux, or `OPENROUTER_API_KEY`;
without them they skip (exit 2), never pass.

## CI

`.github/workflows/core.yml` runs the static suites and, in the `temporal` job,
installs the Temporal CLI, starts a real `temporal server start-dev` on `:7243`,
and runs the Temporal-only proofs (`graph-restart`, `durable-restart`,
`graph-child`, `graph-continue-as-new`, `graph-cancel`, `effect-receipt`). That
step exits 2 if any of them skips, so a missing server fails the job instead of
silently passing. `integrations/postgres/concurrency.ts` runs in
`postgres-live.yml`; the k8s/gVisor proofs are `workflow_dispatch` (no cluster on
the hosted runner) and are run by hand.

## What still lives outside the repo

`/tmp/opencode` is scratch: the multi-round review prose, the two-fake-server
provider attack script, and the ad-hoc gym probes. The durable ones are encoded
above as tests; the provider attack's mechanism is covered at unit level by
`test/provider-config.test.ts`, and the gym capability inventory by
`scripts/scorer-isolation-probe.mjs`. The gym's scorer attacks were encoded in
`test/gym-forge.test.ts` when the `gym-runner` branch merged into `main`
(`9fad1dd`); the remaining scorer-isolation gap is the host-boundary entry in
`docs/KNOWN-OPEN.md`.
