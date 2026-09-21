# Gym synthetic rung — live measurement

The first real data point on the question this project exists for: **how far can
an agent get in the cheap world before it must escalate to the isolated one?**

Driver: `integrations/gym/synthetic-rung-compare.ts` (committed, re-runnable).
Write-up of the recorded run below.

## Runner — read this before the numbers

The run used the **synthetic rung**: `MemoryWorkspace` (source-backed) +
`SyntheticExecutor` through the `ExecutionBroker`. Workspace effects
(`list/read/write/replace`) execute in **worker RAM**; `process.exec` returns
`ESCALATION_REQUIRED`. So the rung is **unisolated**, it cannot run the visible
test, and it cannot run the git harvest — no patch can leave the synthetic world.

The driver is the **plain loop** (`runGymAttempt` + `createGatewayGymTurn` + the
gym tools), i.e. the same harness the sandbox **plain** arm uses; only the
`EffectRunner` differs. It uses **no Temporal**, so it measures the model+tool
trajectory in the cheap world — **not** durability. It is a labelled control
(`role: "control"`, `rung: "synthetic"`, `isolation: "unisolated"`).

## The run (2026-09-21)

Task `he/hex-decode`, model `kimi-k2.7-code`, gateway loopback, `maxTurns 6`,
deadline 300 s.

| quantity | value |
|---|---|
| outcome | `errored` |
| error | `ESCALATION_REQUIRED` (raised at harvest, after the turn loop) |
| `callCount` / `turns` | 5 / 5 |
| tool calls completed / attempted | **4 / 6** |
| wall | 48.85 s |
| requested / served model | `kimi-k2.7-code` / `kimi-k2.7-code` (no substitution) |

## Trajectory (in order)

| turn | tool call | result |
|---|---|---|
| 0 | `list_files` | ok |
| 0 | `read_file(he.js)` | ok |
| 0 | `read_file(test/visible.test.mjs)` | ok |
| 1 | `run_visible_test` | **ESCALATION_REQUIRED** (the wall) |
| 2 | `replace_in_file(he.js, parseInt radix 10 → 16)` | ok |
| 3 | `run_visible_test` | **ESCALATION_REQUIRED** (second hit) |
| 4 | `finish` | (loop ends; not executed) |

The agent read the tree, the bugged source and the test (3 calls), tried to
verify → wall, applied the correct one-line fix **without** a green test, tried
to verify again → wall, then finished. `run_visible_test` escalated on every
attempt and the harvest escalated too, so the synthetic world produced no scored
patch.

Sandbox durable reference (same task/model, 2026-09-21): 5 calls —
`list_files`, `read_file`, `replace_in_file`, `run_visible_test`, `finish`.

### Re-runs (the wall is stable, the ordering is not)

The model is stochastic, so the tool ordering and the completed count move
run-to-run while the wall does not. Two re-runs the same day: one ordered the
fix before any test (`list_files`, `read_file`, `replace_in_file` → wall →
`finish`; 3 of 4 completed, 5 calls, 32.9 s), another retried the test twice. In
every run `run_visible_test` returned `ESCALATION_REQUIRED`, the harvest
escalated, and the outcome was `errored`. The table above is the first recorded
run; treat its counts as one sample, not a constant.

## Re-running

```bash
SYNTH_FIXTURE_REPOS=/tmp/opencode/fixture-repos \
SYNTH_GATEWAY_URL=http://127.0.0.1:8787 \
integrations/temporal/node_modules/.bin/tsx integrations/gym/synthetic-rung-compare.ts \
  --task test/fixtures/gym-tasks/he/hex-decode --model kimi-k2.7-code --turns 6
```

`--model` and `--task` are flags, so the same question can be asked of a
different model or a harder task without editing the driver, and again once
harvest can leave the synthetic world (which would turn the harvest wall into a
scored patch). A missing gateway is a SKIP (exit 2), never a pass.
