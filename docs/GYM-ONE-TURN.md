# Gym: one turn body, and the remaining workflow restructuring

Status history from `a6109b5` through `209967d`, plus the gym-7 decision that
settles the durable arm's shape. It records what landed for "kill the parallel
gym turn", the gap that was closed, and why the gym does **not** drive
`durableAgentWorkflow`. The a6109b5-era shape below is superseded; the code is
the authority.

## Landed

- **One gateway turn body.** `src/runtime/gateway-engine.ts` (`GatewayAgentEngine`)
  is the only place that builds a `/v1/chat/completions` request. The gym's
  `createGatewayGymTurn` (`src/gym/turn.ts`) is a thin adapter that configures
  that engine with the gym system prompt and tool-call parser, then maps its
  outcome back to the gym turn shape. It makes no HTTP call of its own.
- **The durable arm ran the runtime agent workflow (at a6109b5; superseded).**
  `gymAttemptWorkflow` handed the attempt to `durableAgentWorkflow` as a child
  workflow, which proxied the gym's `runTurn` activity. The path was

      gymAttemptWorkflow -> durableAgentWorkflow -> runTurn ->
      GatewayAgentEngine -> sandbox rung `process.exec` (gVisor pod)

  That shape could not give one `runTurn` activity per turn: the child ran one
  `runTurn` activity that looped the whole attempt internally. `209967d` moved
  the loop into `gymAttemptWorkflow` (see "Closed" below and the Decision).
- **Control arm** stays the plain loop, labelled `role: "control"`; the local
  runner stays refused-for-scored at the activity boundary.

### Evidence at a6109b5 (scripted gateway, zero quota; superseded)

`/tmp/opencode/gym2-trace-proof.mjs` (log `gym2-trace-proof.log`):

| quantity | value |
|---|---|
| parent workflow type | `gymAttemptWorkflow` |
| child workflow type (history) | `durableAgentWorkflow` |
| child activity type (history) | `runTurn` |
| model HTTP requests (`GatewayAgentEngine`) | 1 |
| `run_visible_test` | PASS (exit 0) in the pod |
| outcome / isolation / patch | `passed` / `gvisor` / 358 B |

Two-arm run with a scripted 502 on the control's first request
(`gym2-two-arm-fault.log`): control `errored` (0 B), durable `passed` (358 B),
both `gvisor`, 2 model requests. The two-arm run still differentiates and the
sandbox arm runs the visible test in the pod.

## The remaining gap (at a6109b5): the loop was still inside the activity

Measured (`/tmp/opencode/gym2-multiturn-gap.mjs`, log `gym2-multiturn-gap.log`):
a two-turn attempt produced `turns: 2`, `callCount: 2`, `modelHttpRequests: 2`,
but **`runTurnActivities: 1`**. The child `durableAgentWorkflow` ran one
`runTurn` activity that internally looped both turns (`runGymAttempt`). The
target is one `runTurn` activity per turn, with the loop, transcript and park in
the workflow.

This is the failing assertion the restructuring must satisfy:

```ts
// one runTurn activity per model turn
assert.equal(runTurnActivities, out.turns); // 2 !== 1 today
```

### Why it is not a one-line change

1. **Transcript vs mailbox.** `durableAgentWorkflow` feeds `runTurn` the mailbox
   snapshot, and `GatewayAgentEngine.buildUserMessage` renders one user message.
   The gym needs a growing transcript (assistant turns + tool observations). The
   workflow must own that transcript and pass it each turn; the runtime workflow
   currently has no per-turn "append and continue" shape.
2. **Tool specs vs the gym tool surface.** `DurableToolSpec` maps a tool to one
   of five effects. `list_files`/`read_file`/`write_file`/`run_visible_test` map
   cleanly (`workspace.list/read/write`, `process.exec`), but `replace_in_file`
   is a read-modify-write (needs a `workspace.replace` effect) and `finish` is a
   terminal control signal, not an effect.
3. **Persistent sandbox workspace.** Main's sandbox rung seeds a `MemoryWorkspace`
   and keeps it in a worker-process map; `process.exec` runs in a one-shot pod.
   A turn-per-activity loop needs the workspace to survive across activities (a
   durable workspace store the pod mounts, or a persistent pod per attempt).

### Sketch

- Add `workspace.replace` to `Effect` and the synthetic executor; map
  `replace_in_file` to it in the gym `toEffect`. Treat `finish` as a terminal
  marker the workflow reads off the turn result.
- Give `durableAgentWorkflow` a per-turn continue path (append the turn's
  assistant/tool messages to the mailbox and re-run) or introduce a thin
  gym agent workflow that loops `runTurn` activities; keep `durableAgentWorkflow`
  as the lifecycle leaf per the harness spec.
- Move plant/harvest/score into the orchestrator as separate activities, so
  `runTurn` runs exactly one turn.

The `turnConfig` is already carried into the activity; when the tool-spec mapping
exists, the gym's `runTurn` becomes the runtime's `createGatewayRunTurn` body with
the gym's tools, and the gym's bespoke `runGymAttempt` loop can be deleted.

## Closed (gym-3, `209967d`)

The loop now lives in workflow code. `gymAttemptWorkflow` owns it:

    gymPrepareActivity -> for each turn: runTurn -> gymScoreActivity

One `runTurn` activity per turn; the transcript is workflow state; a transient
turn failure parks (honouring a server retry hint) and retries the same turn.
Each turn runs `GatewayAgentEngine` with the gym's `turnConfig` (`buildToEffect`)
and the sandbox rung's `executeEffect`: `run_visible_test` is a fixed
`process.exec` in the pod, `replace_in_file` is a new `workspace.replace` effect,
and `finish` is read off the turn's tool calls.

**Red before:** `gym2-multiturn-gap.log` — 2 turns, 1 `runTurn` activity.
**Green after:** `gym3-turn-per-activity.log` — 2 turns, **2 `runTurn`
activities**, 1 `gymPrepareActivity`, 1 `gymScoreActivity`, 2 model requests,
`outcome: passed`, `patchBytes: 358`. The workspace survived across the two
activities: turn 1's `replace_in_file` and turn 2's `run_visible_test` both went
through the same persistent rung, and the visible test passed on turn 1's edit.

### Workspace-across-activities dependency

Between turns the workspace is the persistent rung keyed by the attempt
(`sandbox.ts`), so it survives any number of activities in one worker process.
Across a worker restart the rung is cold and the `runTurn` activity restores the
attempt's checkpointed patch (`BlobGymCheckpointStore`) before the turn. That is
the existing primitive; a truly durable workspace store (so the pod mounts the
same state without a patch replay) is the `synth-1` dependency, not yet landed
on `main` (`git log main -- src/execution` shows no workspace store).

## Decision (gym-7) — the gym does not drive `durableAgentWorkflow`

> Naming: this decision was written when the gym's turn activity was called
> `runTurn`; it is now `gymRunTurn`, renamed so the gym and the runtime can share
> one worker (a worker registers one activity per type name). The historical
> sections below keep the old name.

`SPEC-super-harness.md` item 1 says every path is a Temporal workflow/activity,
and its gym-2 workstream said "the gym drives the harness workflow". Measured
(`gym-hero` report, real-model run 2): the gym's durable arm is

    gymAttemptWorkflow -> gymPrepareActivity -> runTurn (activity, xN) ->
    gymScoreActivity

with **no child workflow**. The decision is to keep that shape, not to wire the
gym to `durableAgentWorkflow`, because the two workflows are different kinds:

- **Bounded vs long-lived.** The gym is a bounded attempt: `gymAttemptWorkflow`
  loops `for (turn = 0; turn < input.maxTurns; turn++)` with a `deadlineMs`
  (`integrations/temporal/src/gym-workflows.ts:74-85`), then scores.
  `durableAgentWorkflow` loops `while (!cancelled && status !== "completed" &&
  status !== "failed")` and waits on mailbox signals
  (`integrations/temporal/src/workflows.ts:47-75`), with no turn cap and no
  deadline; it lives until cancelled or its external mailbox lifecycle ends.
- **Input shape.** `durableAgentWorkflow` passes `runTurn` a mailbox snapshot
  (`workflows.ts:100-107`) and its `runTurn` returns classifications or tool
  observations (`gateway-run-turn.ts:439-441`); it has no per-turn
  append-and-continue transcript. The gym needs a growing transcript of
  assistant turns and tool observations, which `gymAttemptWorkflow` owns as
  workflow state (`gym-workflows.ts:76, 96-99`). This was already the blocker
  identified at a6109b5 (`## Why it is not a one-line change` above).
- **Outputs and terminal control.** The gym harvests the pod patch and
  checkpoints it every turn (`gym-activities.ts:241-258`) and reads `finish` off
  the turn's tool calls (`gym-activities.ts:240`), then scores the held-out
  vectors (`gym-workflows.ts:102`). `durableAgentWorkflow` returns
  `DurableAgentState` (mailbox/status); it has no patch, checkpoint, score or
  `finish` concept. Its terminal states are driven by the mailbox lifecycle, not
  by a model tool.
- **The spec itself says so.** `SPEC-super-harness.md:48` — "Keep
  `durableAgentWorkflow` as the agent-lifecycle leaf." The a6109b5 sketch
  (`### Sketch` above) already offered exactly this: introduce a thin gym
  workflow that loops `runTurn` activities, and keep `durableAgentWorkflow` as
  the lifecycle leaf.

The bar's real requirement is item 1: one execution model, no production
in-process loop outside Temporal. That holds: `gymAttemptWorkflow` is a Temporal
workflow, each turn is the `runTurn` activity, and both the gym activity and the
runtime activity run the **one** turn body, `GatewayAgentEngine`
(`gym-activities.ts:218-239`, `gateway-run-turn.ts:394-412`). What is
gym-specific is the bounded attempt container (prepare/loop/harvest/score),
which is deliberately not the interactive mailbox lifecycle.

Wire-it-(a) would require either extending `durableAgentWorkflow` with
`maxTurns`/`deadline`/transcript-append/harvest/score — turning the interactive
lifecycle leaf into a batch runner — or having the parent send one `sendMessage`
signal per turn, wait for the child to return to `idle`, and cancel it at the
end; that leaves the loop in the parent anyway and makes the child a per-turn
signal RPC. Neither is better than the current shape.

### Evidence (scripted gateway, zero quota)

`tsx integrations/gym/run-gym.ts --runner sandbox --arm durable --gateway
http://127.0.0.1:8898 --model scripted --turns 4` (artifact
`/tmp/opencode/orch/gym7-scripted4-*.log`, history
`/tmp/opencode/gym6/gym7-history.json`):

| quantity | value |
|---|---|
| workflow type | `gymAttemptWorkflow` |
| activities | `gymPrepareActivity` x1, `runTurn` x2, `gymScoreActivity` x1 |
| child workflows started | **0** |
| outcome / isolation / patch | `passed` / `gvisor` / 358 B |
| turns / runTurn activities | 2 / 2 (turn-per-activity) |

The real-model run (`headline2-report.md`, `gym-hex-decode-muatl6g4`) shows the
same shape with `runTurn` x4, 0 child workflows, `passed`, 358 B.

`test/gym-durable-path.test.ts` pins this: the gym workflow must own the loop and
must not start or reference `durableAgentWorkflow`.
