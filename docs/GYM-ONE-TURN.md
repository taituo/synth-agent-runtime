# Gym: one turn body, and the remaining workflow restructuring

Status after `a6109b5` (branch `gym-runner`). This records what landed for
"kill the parallel gym turn" and the one gap that is not yet closed, with the
number that measures it.

## Landed

- **One gateway turn body.** `src/runtime/gateway-engine.ts` (`GatewayAgentEngine`)
  is the only place that builds a `/v1/chat/completions` request. The gym's
  `createGatewayGymTurn` (`src/gym/turn.ts`) is a thin adapter that configures
  that engine with the gym system prompt and tool-call parser, then maps its
  outcome back to the gym turn shape. It makes no HTTP call of its own.
- **The durable arm runs the runtime agent workflow.** `gymAttemptWorkflow`
  (`integrations/temporal/src/gym-workflows.ts`) is an orchestrator: it hands the
  attempt parameters to `durableAgentWorkflow` as the agent (one mailbox
  message), which proxies the gym's `runTurn` activity. The path is

      gymAttemptWorkflow -> durableAgentWorkflow -> runTurn ->
      GatewayAgentEngine -> sandbox rung `process.exec` (gVisor pod)

  The gym worker re-exports `durableAgentWorkflow` so the child workflow type is
  registered in the bundle.
- **Control arm** stays the plain loop, labelled `role: "control"`; the local
  runner stays refused-for-scored at the activity boundary.

### Evidence (scripted gateway, zero quota)

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

## The remaining gap: the loop is still inside the activity

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
