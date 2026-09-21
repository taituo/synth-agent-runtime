# Synthetic-rung data point (first real measurement)

Same gym task, same model, same gym harness (`runGymAttempt` + `createGatewayGymTurn` + the gym
tools), **synthetic rung** (`MemoryWorkspace` source-backed + `SyntheticExecutor` via
`ExecutionBroker`/`brokerEffectRunner`) instead of the gVisor sandbox. Plain control arm (no Temporal).
Throwaway driver, not committed.

- task: `he/hex-decode` · model: `kimi-k2.7-code` · gateway: `http://127.0.0.1:8787` (tunnel) · maxTurns 6
- **callCount 5 · turns 5 · tool calls completed 4 / attempted 6 · wall 48.85 s**
- outcome `errored`, error `ESCALATION_REQUIRED` (raised at `harvestPatch`/git, after the turn loop)
- requestedModel = servedModel = `kimi-k2.7-code` (no substitution)

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

The agent: read the tree + the bugged source + the test (3 calls), tried to verify → wall, applied the
correct one-line fix **without** a green test, tried to verify again → wall, then finished. The
synthetic world cannot exec, so `run_visible_test` escalated on every attempt and the harvest (git)
escalated too, so no scored patch was produced.

Sandbox durable reference (2026-09-21, same task/model): 5 calls — `list_files`, `read_file`,
`replace_in_file`, `run_visible_test`, `finish`.
