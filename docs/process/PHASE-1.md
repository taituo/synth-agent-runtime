# Phase 1 — run the whole thing once, carefully

Answers to your two questions first, then the plan.

## Your question 1: pull the workers off main?

**Yes. Freeze `main` for the duration of Phase 1.**

Phase 1 is "run what exists", not "build". If main moves while the first end-to-end run is
being attempted, a failure becomes ambiguous — you cannot tell whether it is the system or a
change that landed mid-flight. That ambiguity is expensive exactly once, and this is the once.

Finish `merge-4`, then stop. Workers can keep working on branches; nothing merges to main until
the run has happened or has been shown to be blocked.

The one exception is a fix that the run itself proves necessary. If the run fails because of a
defect, fixing that defect is Phase 1 work. Anything else waits.

## Your question 2: `replaceInText`

**Correct call, and thank you for noting it rather than changing it.** Indentation-tolerant
edit semantics is harness territory — a real harness has spent years on exactly that. It should
not live in Synth's execution layer.

Do not fix it now. Add it to `docs/KNOWN-OPEN.md` as a drift item with one line on why, so it
is in the repo rather than in your context. Phase 3 decides its fate: once a real harness
supplies its own edit semantics, ours either becomes dead code or turns out to be needed for
the synthetic rung specifically — and that is a measurement, not a guess.

---

## Phase 1, in five steps with a check each

Careful means incremental. Each step is verified before the next, so a failure names its own
cause instead of appearing at the end as "the run did not work".

Everything runs on `big` (`ssh -i <ssh-key> tiny@<big-host>`, internal 10.92.1.1).
`tiny` cannot host this: ~3 Gi free, and the run needs about 6.

### P1.1 — PostgreSQL

Schema from `deploy/postgres/001–003`. Two consumers, two databases in one instance: Temporal's
persistence and our own world/artifact store.

*Check:* connect and list the tables. `synth_effects` and `synth_workspace_checkpoints` exist.

### P1.2 — Temporal, Postgres-backed

**Not `start-dev`.** Its state is in memory, which means worker death is testable but Temporal
death is not. Durability is the project's central claim, so a dev server would make the first
run prove less than it appears to.

*Check:* a trivial workflow completes. Then **restart Temporal and confirm the workflow history
is still there.** That is the step a dev server fails, which is why it is a check and not a note.

### P1.3 — Gateway

Bind to loopback or the private interface only. Provider key in the gateway's environment.
**The sandbox must never receive it.**

*Check:* `/v1/models` responds and names more than one model.

### P1.4 — Worker on the host

On the host, not in the cluster, for this first run. It reaches Temporal and the gateway over
loopback and creates sandboxes through the k8s API. Fewest moving parts, and it is how the
tests already work. Moving the worker into the cluster needs a gateway binding change, a
service account and a worker image — three new things that could break at the same time as the
thing being measured. That is its own step, later.

*Check:* the worker polls its task queue and Temporal shows it as registered.

### P1.5 — One run

**Use the gym path: `gymAttemptWorkflow`.**

Reasoning, so you can object if you disagree: it already runs a real repo task end to end, it
exercises the full chain — multi-turn loop, effects, broker, sandbox pod, receipts, scoring —
and it produces a *number* rather than an impression. DIRECTION requires each phase to end in a
measurement. And it needs no harness improvement, which Phase 1 forbids.

The generic `durableAgentWorkflow` path would also demonstrate the chain, but its default task
is event classification and its engine is the thin one. Less proven per unit of effort.

If you think the generic path is the better Phase 1 subject, say why and I will reconsider —
but do not run both.

*Check — this is the deliverable:* one run, and the ID chain printed from it.

```
agentId → Temporal Workflow ID → activity → effect.id
        → sandbox ID → pod → receipt → outcome
```

Every arrow in that chain traced from one execution, in logs, with the pod visible in
`kubectl get pods -n synth-sandboxes` while it runs.

## What Phase 1 is not

- **Do not improve `GatewayAgentEngine`** to make the run look better. If the run is
  unimpressive because the harness is thin, that is the correct result and it is the argument
  for Phase 3. DIRECTION says this explicitly.
- **Do not add features** that the run does not require.
- **Do not fix defects the run does not hit.** Note them.

## Reporting

`/tmp/opencode/phase1-log.md`, one entry per step: what you ran, raw output, what you checked
afterwards, and status. One line per step to the PROGRESS LOG in `BRINGUP-PLAN.md`.

State the expected result before each check, so a surprise is visible as a surprise.

When a step fails, stop and report rather than working around it. A workaround at P1.2 becomes
an unexplained failure at P1.5.
