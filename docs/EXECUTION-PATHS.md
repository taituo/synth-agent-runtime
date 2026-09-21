# Execution paths: Temporal, control, or dev

One execution model: a production agent turn, effect, loop or schedule runs
inside a Temporal workflow/activity. This document inventories every loop,
scheduler and driver in the repo and says which category it is in, so no
in-process production loop runs silently.

- **PRODUCTION** — Temporal workflow, activity, child workflow, or Schedule.
- **CONTROL** — a deliberate comparison arm that does not use Temporal. It must
  be machine-readable labelled (`role`, `isolation`/`unisolated`) and refused
  on a scored path.
- **DEV / DEMO** — a live proof, driver, harness or example. Not shipped as a
  runtime path; labelled by its script name and doc.
- **DEAD** — no caller; removed or recorded.

## Production (Temporal)

| path | execution | note |
|---|---|---|
| `integrations/temporal/src/gateway-run-turn.ts` | `runTurn` activity — the one turn body | shared `GatewayAgentEngine`; no HTTP client of its own |
| `integrations/temporal/src/workflows.ts` | `durableAgentWorkflow` loop (mailbox + park/backoff timers) | the agent-lifecycle leaf |
| `integrations/temporal/src/graph-workflow.ts`, `src/graph.ts` | graph interpreter: sequences, fan-out/join, branches, loops, child workflows, `continueAsNew`, `cancelGraph` | inside the workflow |
| `integrations/temporal/src/gym-workflows.ts` | `gymAttemptWorkflow` — one turn per `runTurn` activity, workflow owns the loop | durable gym arm |
| `integrations/temporal/src/gym-activities.ts` | `gymPrepareActivity` / `runTurn` / `gymScoreActivity`, one `engine.run` each | caller of the shared body |
| `integrations/temporal/supervisor/workflows.ts` | `superviseSessionWorkflow` check-in loop (durable timers) | one per supervised session |
| `integrations/temporal/supervisor/schedule.ts` + `supervise.ts` | Temporal **Schedule** starts the supervisor and re-creates it if it dies | production start path; `supervisor:supervise` CLI |

The runtime worker (`integrations/temporal/src/worker-entry.ts`) only registers
these workflows/activities; it runs no turn loop of its own.

## Control (labelled, refused on a scored path)

| path | why it is a control | label / refusal |
|---|---|---|
| `integrations/gym/run-gym.ts` plain arm | the same task with no runtime | `role: "control"`, `isolation`; `assertScoredRunnerAllowed` refuses `runner:"local"` |
| `integrations/gym/run-gym.ts` `--dry-run` | simulates durability with a local retry, drives `localEffectRunner` | `role: "control"`, `isolation: "unisolated"`, top-level `unisolated: true` |
| `integrations/gym/p2-faults.ts` plain arm | fault-matrix comparison arm (child process) | `role: "control"`, `isolation`; `runner:"local"` refused (`GymUnisolatedScoredRun`) |
| `src/gym/attempt.ts` (`runGymAttempt`) | the shared turn loop; in-process only when a **plain/dry** arm calls it | inherits the arm's label; the durable arm calls it inside a Temporal activity |
| `src/gym/turn.ts` (`createGatewayGymTurn`) | a caller of the shared body for the plain arm | inherits the arm's label |
| `integrations/gym/sandbox.ts` (`localEffectRunner` path) | the unisolated runner | `describeGymRunner` reports `isolation: "unisolated"`, `scoredAllowed: false` |

The scorer itself is not an arm: `src/gym/scoring.ts` runs the isolated verifier
(worker + permission model + `SYNTH_REQUIRE_ISOLATION`) and is the decision.

## Dev / demo (not shipped)

- `examples/demo.ts`, `examples/gateway-demo.ts`, `examples/kubernetes-demo.ts` —
  demos of the turn body / gateway / execution rung.
- `integrations/temporal/*driver*.ts`, `*-live.ts`, `restart-worker.ts`,
  `graph-restart-worker.ts`, `effect-receipt-live.ts` — live proofs; they drive
  Temporal workflows or a fake gateway and are run by `scripts/live-proofs.mjs`.
- `integrations/kubernetes/*.ts` — gVisor execution proofs.
- `integrations/postgres/*.ts` — Postgres concurrency/fencing proofs.
- `scripts/*.mjs`, `scripts/*.ts` — proof runners (`live-proofs`, `verify`,
  `secret-scan`, `check-integrations`, the lane/litellm live scripts).

## Not an agent loop (service / library IO)

These are loops, but not turn/effect execution paths: the inference gateway
HTTP accept loop (`src/inference/gateway/server.ts`), the `git cat-file --batch`
reader (`src/workspace/git-batch.ts`), subprocess/timer helpers in
`src/execution/kubernetes/*`, the lane-scheduler timer, and the engine's
heartbeat interval (which runs inside a Temporal activity).

## Dead / removed

- `src/control-plane/lease.ts` `withRenewingLease` — a homegrown
  `setInterval` lease-renewal loop with no caller; removed. Durable
  wait/renewal is a Temporal timer in a workflow, not a host interval.
- `src/artifacts/retention.ts` `prune` — no scheduler; a caller decides when to
  run it (post-run step or an operator cron). It is not a turn/effect loop. See
  `docs/KNOWN-OPEN.md` for the still-open automatic-GC wiring.
  *(This is a library API with unit tests but no production caller; kept, not
  wired — flagged here rather than silently accepted as wired.)*
- `src/observability/trace.ts` — an earlier plain `Trace`/`TraceEvent` sink,
  superseded by OpenTelemetry (`src/observability/otel.ts`). No caller; moved to
  `docs/history/museum/src/observability/trace.ts` and dropped from the barrel.
- `scripts/chaos-matrix.mjs` (`npm run chaos:matrix`) — ran
  `dist/test/chaos.test.js`, which was quarantined to `docs/history/museum/`; the
  script exited 1 on a missing file and its remaining suites are already in the
  root `npm test`. Removed.

## The check

```bash
# turn loops outside Temporal: the shared gym loop is the only in-process one,
# and only a labelled control calls it.
grep -rn "runGymAttempt(\|engine.run(" src integrations --include='*.ts' | grep -v /dist/ | grep -v test
# schedulers: the supervisor is the only cron, and it is a Temporal Schedule
grep -rn "setInterval(\|cronExpressions\|client.schedule" src integrations --include='*.ts' | grep -v /dist/ | grep -v test
```

Anything new that runs turns/effects must be a Temporal workflow/activity or
carry a `role`/`isolation` label and a scored-path refusal.
