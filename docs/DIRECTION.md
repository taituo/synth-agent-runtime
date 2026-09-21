# Direction: who owns what

This document exists because the boundary drifted, and the drift was only noticed from the
outside. Read it before adding anything to the turn body, the workflow, or the execution path.

## The thesis

> **Synth does not own agent intelligence.** It takes an existing coding harness and makes its
> execution durable, isolated and measurable.

Every later decision is checked against that sentence. If a change makes Synth know more about
how to write code, it is in the wrong layer.

## What went wrong, stated plainly

`GatewayAgentEngine` grew into a de-facto agent harness. It makes one model call, parses tool
calls, executes them and returns. The model never sees the result of its own tools inside a
turn, so it is not an agent loop — but because it sits under `durableAgentWorkflow`, it became
the project's working definition of "an agent".

That definition is wrong in both directions. It is too thin to be a coding agent, and it
competes with harnesses that already solve the problem far better: context management, tool
feedback, compaction, read/edit/bash semantics, prompts refined over years.

The root cause is a layering inversion: **Temporal ended up above the harness instead of below
it**, so durability dictated agent semantics ("one activity = one model call"). Agent semantics
must never come from the durability layer.

Note that a correct multi-turn loop already exists in the gym path: `gymAttemptWorkflow`
iterates turns in the workflow, one model call per durable activity, carrying the transcript
across them, parking on transient failure. That shape is right *for the gym*. The problem is
that the generic path has a different, thinner shape, and the thin one carries the name "agent".

> **The gym loop is correct for the gym, and is not a template for harness adapters.** The gym
> is our own bounded benchmark runner — `maxTurns`, a deadline, a score — so "one model call per
> durable activity" suits it. A real harness owns its own loop and may run any number of model
> and tool iterations between Synth session checkpoints. Do not derive harness session semantics
> from the gym's activity granularity: that would be this same layering inversion a third time.

## The layers

```
  HARNESS                            not ours
  agent loop · context · prompts · tool semantics · compaction
        │
  ADAPTER                            thin, ours
        │
  ┌─────┴─────────────┐
  │                   │
EXECUTION           SESSION
environment         durability
  │                   │
Effect →            checkpoint · restore
ExecutionBroker     heartbeat · wait
  │                   │
synthetic | gVisor  Temporal (one backend)
        │
  ORCHESTRATION                      above agents, not inside them
  graph · swarm · fan-out · review · approval
        │
  MEASUREMENT
  gym · A/B
```

## Two boundaries that decide everything else

**1. The harness never sees Temporal.** It sees `session.checkpoint()`, `session.effect()`,
`session.wait()`. Temporal is an implementation of the session layer, not an interface the
harness codes against. Breaking this is what produced `GatewayAgentEngine`.

**2. Synth does not make the model call on the harness's behalf.** The harness owns model-call
semantics. Synth's gateway may be an optional transport *underneath* it — useful for provider
routing and quota handling — never a replacement *above* it.

## Integration levels — and what we do NOT owe

Harnesses integrate at different depths, and **the depth determines which execution
environments are available**. This is a deliberate scope reduction.

| Level | How it integrates | Environments available |
|---|---|---|
| **3 — native** | We replace the harness's own execution environment | synthetic **and** gVisor |
| **2 — SDK** | The harness calls Synth's runtime API for tools | gVisor |
| **1 — ACP / process** | The harness runs as a process we supervise | gVisor |

**Synthetic execution is not a platform promise.** It is available only where a harness's
execution seam is small enough to replace wholesale. Pi is the candidate — that is the reason
Pi was chosen originally, and it remains a good reason: a small, comprehensible codebase whose
`ExecutionEnv` can be swapped without rewriting the harness.

Every other harness gets gVisor and nothing else. We do not owe anyone a synthetic environment,
and we must not shape the adapter interface around providing one universally.

This also scopes the research question correctly: the synthetic-vs-sandbox A/B is a **Level 3
experiment**, not a property of the platform.

## The research question this exists to answer

> Can a cheap synthetic environment substitute for a real one without changing agent
> behaviour? Same harness, same model, same task — swap only the environment.

```
        one harness, one task, one model
                     │
        ┌────────────┴────────────┐
        │                         │
  synthetic env              gVisor env
        │                         │
        └────────────┬────────────┘
                     │
   compare: success · patch · tool trajectory
            latency · cost · divergences
```

The machinery for this already exists and is rigorous: `test/rung-parity.test.ts` diffs the
same effect sequence against `SyntheticExecutor` and a raw `node:fs` oracle that imports no
implementation code, so it cannot flatter the thing it measures. What has never been run is
this comparison with a *real harness* driving it instead of a thin engine.

## Phases

Each phase ends with a **measurement, not a feature**. A phase is done when a number exists and
someone has made it fail on purpose.

**Phase 0 — Record the boundary.** Demote `GatewayAgentEngine` to a reference harness in the
docs and in how it is described. Mostly documentation; delete nothing, keep its tests. This
comes first because it stops the drift — otherwise every addition grows the wrong layer.

**Phase 1 — Run the whole thing once, end to end, with what exists today.** No new architecture
until the chain `agentId → workflow → effect → sandbox → pod → receipt` has been executed in a
single run. Running it reveals what is actually missing; designing does not.

> **Keep Phase 1 small, and do not improve `GatewayAgentEngine` to make the run look good.**
> The run has to demonstrate the chain and nothing else. Any effort spent making the reference
> harness behave more like a coding agent is effort spent growing the layer this document
> exists to shrink. If the run is unimpressive because the harness is thin, that is the
> correct result and it is the motivation for Phase 3.

**Phase 2 — Define the seam.** `ExecutionEnvironment` and `HarnessSession` as interfaces.

> **Design the interface against a real harness's API, not against the existing engine.**
> This is the one place the drift can recur. An interface derived from what
> `GatewayAgentEngine` needs would come out as `run(messages) → content + toolCalls +
> observations`, because that is all it does. A real harness needs more: session lifecycle,
> resume, interrupt, approval, streaming, compaction hooks. An interface shaped by the thin
> engine would be too narrow, and the reference harness would once again be dictating the
> platform abstraction.
>
> So: read a real harness's API first and design the seam to fit it. Then have the existing
> engine implement the same interfaces — as a *second* implementation that shows the seam is
> cheap to satisfy, never as the source of its design.
>
> **Phase 2 exit criteria**, all four:
> 1. a real harness's API has been read and the seam designed against it;
> 2. `ExecutionEnvironment` and `HarnessSession` are defined;
> 3. `GatewayAgentEngine` implements them;
> 4. a **compile-level adapter skeleton** exists for the real harness and type-checks against
>    that harness's real types.
>
> Criterion 4 is what makes this a check rather than a claim. Reading an API and then writing
> an interface the thin engine satisfies leaves exactly one implementation, which is the
> situation this guard exists to prevent. No real coding task has to run yet — that is Phase 3.
> The skeleton only has to compile against types we did not write.
>
> **Which harness.** Pi is the reality check for Phase 2, consistent with it being the Level 3
> candidate. Read the OpenCode SDK alongside it as a cross-check — *does this seam look
> immediately stupid in an SDK-shaped world?* — without building an adapter for it. A seam that
> looks reasonable in both a small native integration and an SDK world is shaped like Synth
> rather than like one harness. Which harness gets the first real adapter stays a Phase 3
> decision.

**Phase 3 — One real adapter.** One harness, not three levels at once. The measurement is a
real coding task completed in the sandbox by a harness Synth did not write.

**Phase 4 — The A/B.** Level 3, the comparison above. This is what the rest was built for.

**Phase 5 — Orchestration above agents.** The graph and swarm work finds its correct home:
several agents, fan-out, a reviewer that sees every patch, an approval signal, a workflow that
parks overnight. Temporal is excellent at this — as long as it sits *around* agents rather than
*inside* them.

## What this does not mean

- **Do not delete `GatewayAgentEngine`.** It is a useful dependency-free reference harness for
  testing the runtime, the gateway, effects and the sandbox. It simply stops being the
  definition of an agent. Do not grow it: no planner, no context compaction, no prompt
  framework, no new agent features.
- **Do not discard the Temporal, broker, gVisor, receipt or checkpoint work.** All of it sits
  below the harness and serves any harness plugged in above. It is the load-bearing part and
  it is the part that is hardest to get right.
- **Do not treat this as a rewrite.** The missing piece is an adapter at a seam that already
  exists.

## Open items this does not resolve

These remain open and are tracked separately: no end-to-end run yet; workspace does not survive
a worker crash on the generic path (`synth_workspace_checkpoints` exists as a table, the wiring
does not); `durableAgentWorkflow` has no `continueAsNew`, so a long-lived run's history grows
unbounded; no load test, no concurrency cap, no multi-tenancy.
