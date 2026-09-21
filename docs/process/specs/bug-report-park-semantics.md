# Bug report: a durable agent dies permanently on a transient provider failure

Repo: /home/tiny/projects/pisynth/synth-agent-runtime (work directly here, push to origin/main when green).
Package: integrations/temporal

## Bug 1 (main): retries exhausted => agent ends `failed` forever

`integrations/temporal/src/workflows.ts`: the `catch` around `runTurn` sets
`state.status = "failed"` for ANY activity failure once the activity retry policy
(`maximumAttempts: 3`) is exhausted, and the workflow loop then ends. For a runtime whose
whole point is durability that is a bug, not a design choice: with real inference (rate-limited,
flaky cheap provider accounts) an outage longer than ~3 seconds kills the agent permanently.

Evidence, already reproduced live (Temporal dev server :7243, gateway :8787):
- `flaky-gateway.ts` with `MODE=502 FAIL_FIRST=9999`: all 3 swarm agents end `failed` after 3 attempts, driver returns in ~4s.
- `GATEWAY_TIMEOUT_MS=3000` (timeout below the ~8s model latency): all 3 agents end `failed` in ~12s.
- See the "Known limitation" bullet in CHANGELOG.md (swarm-against-real-inference entry). Remove/replace it when fixed.

### Required behaviour
1. TRANSIENT failure after retry exhaustion => PARK, do not die:
   - `status = "waiting"`, `lastError` = root cause (visible via the `getAgentState` query),
   - mailbox left INTACT (do not splice the messages of the failed turn),
   - sleep with exponential backoff, then retry the same turn. Defaults 5s initial, x2, cap 5 min.
     Overridable per agent through a new OPTIONAL field on `DurableAgentState`:
     `parkBackoff?: { initialMs: number; maxMs: number }` (backward compatible, tests use 400/1600ms).
   - on success: backoff resets, `lastError` is cleared, normal flow resumes.
2. PERMANENT failure => `failed` immediately, one attempt (as today). Mark permanent failures with
   `ApplicationFailure.nonRetryable(...)`:
   - in `src/gateway-run-turn.ts`: HTTP 400/401/403/404/422 => nonRetryable; 408/409/425/429/5xx,
     timeouts, network errors, empty completion, non-JSON/invalid answer => retryable (plain Error).
   - add a sandbox-safe `isNonRetryableFailure(error)` to `src/correlation.ts` (walk the `.cause` chain,
     true if any cause has `nonRetryable === true`) and use it in the workflow's catch. Unit-test it.
3. Cancelling a parked agent must be prompt: park with `condition(() => cancelled, backoffMs)`, not a plain sleep.
4. Decide and document (docs/TEMPORAL.md): do new messages arriving while parked wake it early? (Suggested: no,
   same provider is still down; keep the backoff.) Also note that an unbounded retry loop grows workflow history;
   Continue-As-New is out of scope, just leave a comment/CHANGELOG note.
5. Workflow-side logging: `log.warn("synth.workflow.parked", { attempt, backoffMs, error })` (goes through the
   existing interceptors, so it gets the correlation ids).

Temporal-touching code has the highest bar in this repo (we already found two blockers there: `structuredClone`
in the sandbox, mailbox message loss). Everything you change in workflows.ts / worker.ts / correlation.ts needs a
unit test AND a live-server proof, not a mock.

## Repro / failing-first harness (already written, NOT yet run by me)

`integrations/temporal/park-live.ts` (untracked; add `"live:park": "tsx park-live.ts"` to package.json).
Three scenarios against the real dev server with a controllable activity:
A. transient outage that outlasts one retry cycle (calls 1-4 fail) => must park (mailbox kept, cause visible) then recover to `idle`, `lastError` cleared, never `failed`.
B. permanent failure (`ApplicationFailure.nonRetryable`) => `failed`, exactly 1 activity call.
C. cancel while parked => `cancelled` in < 4s.
Step 1 of your work: run it on the CURRENT code and confirm A and C fail (B should already pass). Record that.
The script passes `parkBackoff` in the initial state; add the field to `DurableAgentState` in `src/contracts.ts`.
Tidy the leftover pointless `Promise.race([...single promise...])` in scenario A while you are there.

## Test loop (recursive: fix -> run everything -> repeat until green, then repeat the whole thing 5x)

After EVERY change run all of these and read the results, do not assume:
1. `npm run build && npm test` in integrations/temporal (unit tests) and `npm test` in the repo root.
2. Live, no model: `npm run live:park`, `live:interceptors`, `live:driver`, `live:swarm`.
3. Live, REAL inference (check `curl -s localhost:8787/health` and Temporal on :7243 first):
   - `npm run live:swarm-inference` (3 agents, 12 events): must stay ok:true, accuracy 36/36-ish, batches like [1,3].
   - Fault scenarios through `flaky-gateway.ts` (`/tmp/opencode/run-fault-scenarios.sh` exists; it starts each proxy in its own
     process group on its own port, and cleans up with `kill -- -PGID`; NEVER use `pkill -f flaky-gateway`, it matches your own
     shell, use `pkill -f "[f]laky-gateway"`). With the fix the expectations CHANGE:
       * `MODE=502 FAIL_FIRST=9999` (always down): agents must end `waiting` (parked), not `failed`; run the driver with
         `SWARM_TIMEOUT_MS=30000` and make it report `timedOut` + status `waiting` + the 502 cause. Adjust the driver's
         `agentsHealthy`/`ok` logic or add an explicit "expect parked" mode rather than weakening the normal path.
       * `MODE=502 FAIL_FIRST=12` (enough to exhaust the retries of all 3 agents, then recovers): must END ok:true,
         all 12 events classified, no agent `failed`, `retriedTurns` > 0, and the parked period visible in the trace/logs.
       * `MODE=hang FAIL_FIRST=1 GATEWAY_TIMEOUT_MS=25000` and `MODE=garbage FAIL_FIRST=2`: must still recover as before.
       * `GATEWAY_TIMEOUT_MS=3000` against the real gateway: agents park instead of dying.
4. Repeat the full loop 5 consecutive times. Any non-deterministic failure is a bug to root-cause (add a repro test), not to retry until green.
Keep concurrency small (3 agents; one shared gateway/Temporal on this box). Long runs go to a log file in the background, poll it.

## Also update
- CHANGELOG.md: replace the "Known limitation" bullet with a proper fix entry (in the existing prose style), docs/TEMPORAL.md: new failure semantics.
- Do not commit `dist/`. Do not touch the `feat/temporal-harness-bridges` branch / PR #1 (another agent owns it; note that it also edits
  integrations/temporal/package.json, so keep your package.json edits minimal to ease that merge).

## Bug 2 (lower priority): flaky root test

Root suite test 45 `SIGKILL during a durable turn is recovered from persisted state` (test/process-crash.test.ts, fixture
test/fixtures/process-crash-worker.ts) failed 2 times in roughly 8 `npm test` runs on 2026-09-19, then 0 failures in 72 later runs
(45 full-suite loops with `node --test dist/test/*.test.js`, 15 isolated, 12 more). The error message was not captured. Hypothesis
(unproven): another agent ran `tsc` in the same working directory while the test spawned the compiled fixture from `dist/`.
Other suspects: the fixture's 5s "failed to enter durable turn" self-exit / the test's 10s ready timeout under load.
Try to reproduce under artificial CPU load and/or with concurrent `tsc`, capture the full error. If it is the shared-`dist/` race, the
fix is process (separate git worktrees per agent), not code; if it is a timing guard, make it robust. Report which it was.

## Report back
A short results table: what failed before (park-live A/C), what passes now, the 5x loop results for each live check, commit SHA(s).
