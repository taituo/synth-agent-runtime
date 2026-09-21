# Spec: the signal swarm, built on the gym pipeline

Repo: /home/tiny/projects/pisynth/synth-agent-runtime.
This is roadmap P3, and the user's chosen sequencing: the code-fixing gym was built first
precisely so this could reuse it rather than start over.

## What carries over, and what does not

Reuse without modification: task materialization, the tool surface over `EffectRunner`, the
shared `runGymAttempt` loop with its per-turn checkpointing, artifact egress and the
provenance index, the fault matrix harness, and the two-arm comparison.

The one thing that does NOT carry over is the ground truth. A code fix is scored by running a
held-out test: objective, cheap, and unforgeable now that the scorer is isolated. A finding
about an event stream has no equivalent — there is no test that says "this observation was
worth making".

That single difference is the whole design problem. Everything else is plumbing we already
have.

## Stage one: planted findings, objective scoring, NO judge

Do not start with a judge. Start the way the corpus did, because it worked: plant the ground
truth in the stream and score against it.

Build an event stream containing known, deliberately planted signals — an incident that
escalates across several messages, a slow-burn pattern only visible across many events, a
correlation between two sources, and decoys that look significant and are not. The agent's
task is to report findings; scoring compares the reported findings against what was planted.

This is objective and costs no judge. It also lets the two-arm comparison and the fault
matrix run exactly as they do today: durability either preserves partial findings across a
SIGKILL or it does not, and that is measurable without anyone's opinion.

Carry over the corpus's hard-won lesson: keep genuinely ambiguous items in the stream, score
them separately from the gate, and never relabel ground truth to agree with whichever model
happens to be running. That mistake was made once already and the circularity took a
multi-model comparison to expose.

## Stage two: the judge, and only for what stage one cannot score

Open-ended findings — an unplanted observation that is nonetheless correct and useful — are
exactly what a swarm is for, and stage one cannot score them. That is where the judge earns
its place: many cheap models produce findings, a few strong ones rank them.

The hard part is not building it; it is verifying it, and that is why it is last. Before
trusting a judge, measure it the way any other instrument would be measured:
- **Agreement with the planted ground truth from stage one.** A judge that cannot recover
  known findings has no standing to rank unknown ones. This is the calibration set and it
  already exists.
- **Stability.** Ask the same judge the same question twice and compare. An unstable judge is
  a random number generator with a vocabulary.
- **Independence.** A judge must not be the model that produced the finding, and the ranking
  should be checked for a bias toward findings phrased in the judge's own style.
- **Cost per judged finding**, so the mass-plus-frontier design can be costed rather than
  assumed. The whole point of a cheap mass is that the expensive judgment is rare.

Report those four before the judge is used for anything that matters.

## Scale and cost

One stream, one agent, both arms first — the same discipline that made the gym trustworthy.
The model comparison work already landed, so choose the mass model and the judge model on
evidence rather than by default, and record which model produced each finding: the
`requestedModel`/`servedModel` distinction exists for exactly this.

Measured context for the sizing: the provider did not throttle at 1000 concurrent calls, so
concurrency is not the binding constraint. The binding constraint is this box's memory, which
has already killed runs.

## What to report
The planted-finding recovery rate per arm, the fault matrix for the signal task, which faults
did not differentiate, the four judge measurements if stage two is reached, and an explicit
list of what the planted stream cannot represent about real signals.
