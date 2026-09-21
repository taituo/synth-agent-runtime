# What this actually is

A plain account of what the runtime does today, what it does not do, and which claims have an
executed proof behind them. Written to be useful to someone deciding whether to look further —
not to impress them. Where a number appears, it was measured; where something is unproven, it
says so.

---

## In one paragraph

Coding agents run untrusted code, lose their work when a process dies, and can't tell you
whether they got better. This runtime addresses those three problems and **deliberately does
not try to be the agent**. It gives an existing coding harness a durable life (an agent is a
workflow: turn, wait, signal, restart, cancel), a real trust boundary to execute in (a gVisor
pod the cluster refuses to run without), and a measurement that resists cheating (a planted bug
in a real repository, scored by tests the agent never sees).

---

## Durability — an agent that survives its own infrastructure

**The agent's life is a workflow, not a process.** Turn, wait, signal, restart, cancel. Between
turns there is nothing to keep alive: an agent can wait for days without a process holding its
place, and wakes when a signal arrives.

**A worker can die mid-turn and the agent continues.** Completed turns are not re-run; the
in-flight one is retried and the rest replays from history. *Proven live: an activity retried at
`attempt=2` after the worker was SIGKILLed, with the earlier turns intact.*

**Rate limits are handled by listening, not guessing.** When a provider says it is busy, the
workflow parks with exponential backoff and honours the server's own `Retry-After` hint instead
of a blind backoff window. *Measured: a 2102 ms difference between the hinted delay and the
blind 300–600 ms guess — the blind version re-asks while still throttled.*

**An agent can be steered while it runs.** A signal pushes a message into its mailbox mid-turn;
a query reads its state without interrupting it. Messages that arrive during a turn survive into
the next one rather than being silently dropped — the consumed set is snapshotted per turn.

**Replay is deterministic** against the real workflow's recorded history, which is what makes
"it resumed correctly" a checkable statement rather than a hope.

## Isolation — a boundary the cluster enforces, not one you remember

**gVisor is the trust boundary.** Agent code talks to a user-space kernel, not the host's. You
can see it from inside: `uname` reports `4.19.0-gvisor`, and the container runtime independently
reports the `runsc` handler — two observations, neither relying on the other.

**The cluster refuses to run an unisolated sandbox.** This is the part that matters. Previously
the code requested isolation correctly, but a caller that forgot got an unisolated sandbox with
no error — safety rested on someone remembering. Now an admission policy rejects any pod in the
sandbox namespace that does not request gVisor, regardless of which caller created it.
*Proven three ways: no runtime class → refused; the wrong runtime class → refused; the correct
one → admitted and running under gVisor. The refusals were also shown to come from that policy
and not from the namespace's security profile, and to hold for pods created indirectly by a
controller.*

**The pod is hardened, not merely isolated.** Non-root, read-only root filesystem, all Linux
capabilities dropped, seccomp on top of gVisor, no service-account token mounted, CPU, memory
and ephemeral-disk limits, and a hard deadline.

**Egress is closed by default.** Per-sandbox network policy, default-deny in both directions,
DNS and nothing else. There is no allowlist because no task has yet demonstrated it needs one —
that is a deliberate decision, recorded, not an omission.

**The agent cannot reach the answers.** The held-out test vectors are unreadable from inside the
sandbox. *Proven with a positive control: the same probe reads them successfully from the host,
so the failure inside the pod measures isolation rather than a missing file.*

## Execution choice — the same tool call, two worlds

**Where a tool call runs is a per-call decision**, made from the fidelity the policy requires,
not hardcoded at the call site. A file write can run in memory; a shell command needs the real
thing.

**The cheap world refuses rather than pretends.** The in-memory environment has no filesystem
and no process execution. Asked to run a command, it returns `ESCALATION_REQUIRED` — an explicit
refusal that can be escalated to a sandbox, rather than a plausible wrong answer.

**Every effect carries a receipt** keyed by an idempotency key. A committed effect replays its
recorded result instead of running again.

**An uncertain side effect is not repeated.** If the process died after a tool call did something
but before the result was recorded, the receipt stays in `started` and a retry returns
`EFFECT_OUTCOME_UNCERTAIN` rather than blindly running it a second time. This is the case most
systems get wrong, and getting it wrong means duplicate writes, duplicate commits, duplicate
charges.

**Two workers cannot claim the same effect.** The claim is atomic, and the agent-state writes are
fenced: lease owner, fencing token and expiry are checked in the same statement as the write, and
only a monotonically increasing token is accepted.

## Measurement — a score that resists the thing being scored

**Real repositories, planted bugs.** A bug is introduced into a pinned commit of a real
open-source project as a reverse patch. The agent's job is to fix it. Scoring uses tests the
agent never sees.

**Six outcomes, not two:** passed, failed, tampered, timed-out, errored, skipped. `tampered` is
the important one — full marks require fixing the bug, not touching the scorer. A patch that
reaches protected paths, or a symlink that escapes the checkout, is `tampered`, not `failed`.
A skip is never a pass.

**The scorer has been broken four times.** Each redesign was signed off by reading its tests, and
each was forged within minutes by someone attacking it instead. Every successful attack became a
permanent regression test, and two generalisable lessons came out of it: *a secret placed in the
environment of a process that runs the adversary's code is not held out at all*, and *a guard
test that only tries an attack you thought of confirms your imagination, not your security.*

## Model routing

**An OpenAI-compatible front door.** Anything that speaks that protocol can use the runtime
without knowing what is behind it. Routing, failover, cooldown and sticky affinity live behind
the door; a profile can span providers, so routing across them needs no new accounts.

**It records what actually answered.** If the upstream names a different model than the one
requested, that substitution is recorded. If it names nothing, the field is `null` — never
back-filled with the requested id, because that would hide exactly the thing worth knowing.

---

## What this does not do

**It is not an agent, and it is not trying to be.** The included turn body is a *reference
harness*: one model call, its tool calls executed, deliberately thin. It exists to test the
runtime. It has no agent loop — the model does not see the results of its own tools within a
turn. Anything that looks like a coding agent must come from a real harness plugged in above.
This is written down as an architectural boundary (`docs/DIRECTION.md`), because the project
drifted across it once and the drift took an outside reader to notice.

**The agent's work does not survive a crash on the generic path.** The workflow recovers; the
edits do not. A resumed attempt was measured reading the unfixed source at turn zero. A table
for workspace checkpoints exists and the gym path now uses one — the generic path does not.

**A long-lived agent's history grows without bound.** There is no continue-as-new on the agent
workflow. The graph workflow has one; the agent workflow does not.

**No multi-tenancy.** The sandbox isolates work, not customers. There is no tenant boundary in
the control plane, no quotas and no per-tenant separation of artifacts or secrets.

**No admission control on sandbox creation.** Nothing limits how many sandboxes can be created
at once. On a single machine the machine is the limit; with an autoscaler that limit disappears
and a runaway loop provisions hardware.

**It has never been run under load.** No 10/100/1000-agent test exists, so the first bottleneck
is unknown and any number about throughput would be invented. The only load measurement that
exists covered the gateway alone and did not touch workers, pod creation or the database.

**It has no users.** Nothing here serves anyone in production. The end-to-end chain —
`agentId → workflow → activity → effect → sandbox pod → receipt → outcome` — was executed
as a single run for the first time on 2026-09-21. Once. It passed, with a real model on a real
repository, and the agent's patch was 358 bytes.

---

## How to read any claim in this repository

**Every claim is supposed to have an executed artifact behind it.** Roughly thirty live drivers
exist for that purpose, each re-runnable, so a proof from last month can be checked today rather
than believed.

That discipline came from getting it wrong. Some habits that survived:

- *Attack it; do not read its tests.* Reading test names confirms your imagination.
- *Run the control.* A check that can only pass is not evidence. Before asserting that something
  cannot be reached, show that it can be reached under control conditions — otherwise you are
  measuring a closed door, not a lock.
- *One variable at a time.* If a probe differs from the control in two ways, the refusal may come
  from the wrong one.
- *Suspect your own probe first* when a result confirms what you expected.
- *A skip is not a pass.*
- *Report numbers, not conclusions.*

Claims that turned out to be overstated have been removed from the documentation rather than
softened, and the removals are in the commit history under their own messages. The history is
not tidy. It is accurate.

---

## The question this exists to answer

> Can a cheap synthetic environment substitute for a real one without changing agent behaviour?
> Same harness, same model, same task — swap only the environment.

The first data point was measured on 2026-09-21. The same task, model and harness ran in the
in-memory environment instead of the sandbox. The agent read the tree, the bugged source and the
test, tried to run the test and hit the wall, **applied the correct one-line fix anyway**, tried
to verify again, hit the wall again, and finished unverified.

Four of six tool calls completed. The fix was right. Only checking it needed the real world.

One task, one model, one run. Not a conclusion — a reason to keep measuring.
