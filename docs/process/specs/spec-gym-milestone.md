# Spec: the gym milestone — a real task with objective ground truth

Repo: /home/tiny/projects/pisynth/synth-agent-runtime. Push to origin/main.
This is roadmap item 4 and it is different in kind from everything before it: until now the
work has proved that the parts function. This is the first time the parts are used to do a
real job. Build it in small pieces as usual.

## The task

Take a Track 1 pinned real repository. Plant a genuine failing test in it. Have agents fix
the code so the test passes, working inside the gVisor sandbox, with the result extracted
through the git transport built in 2c.

Ground truth is objective: the test either goes green or it does not. **No judge is needed
and none should be built here.** That is the whole reason this task was chosen over an
open-ended one — it can be scored by running something, not by asking a model's opinion.

## Cheating is the main design risk — treat it as the primary adversary

An agent told "make this test pass" will, if it can, delete the test, weaken its assertions,
stub the function to return the expected constant, or edit the test runner's config. None of
those are malice; they are the shortest path to the stated goal. If the harness can be
fooled this way, every number it produces is meaningless, so the anti-cheat design comes
before the measurement design.

Required:
- **The planted test is read-only to the agent.** Enforce it, do not merely instruct it.
- **Scoring uses a held-out test the agent never sees**, applied to the agent's diff on a
  clean checkout. The visible test states the requirement; the hidden one decides the score.
  They must not be the same file, and the hidden one should cover cases the visible one does
  not, so a constant-returning stub fails it.
- **Score the diff, not the sandbox's final state.** Extract the patch, apply it to a fresh
  checkout of the pinned commit, and run the hidden test there. Anything the agent did to its
  own environment — installing packages, editing configs, touching the runner — does not
  travel with the patch and therefore cannot affect the score.
- **Reject a diff that touches the test files or the runner config**, and record that as a
  distinct outcome (`tampered`), not as a failure. The two mean different things and the
  distinction is the interesting finding.
- Record every outcome separately: `passed`, `failed`, `tampered`, `timed-out`, `errored`.
  Collapsing them into pass/fail hides exactly what we want to see.

## The control arm — this is what the whole milestone is for

Run the SAME task two ways:
- **with the runtime**: durable turns, leases, effect receipts, the sandbox rung, artifact
  egress by reference;
- **without it**: a plain loop calling the same model with equivalent tools, no durability,
  no leases, no receipts, writing straight to a working directory.

Both arms must use the same model, the same prompt, the same repo and the same planted test,
or the comparison means nothing.

Then inject the faults that are already built and measured: provider 502 and 429 with real
retry hints, a timeout, a worker restart mid-activity, a SIGKILL mid-turn, and two workers
racing the same task. For each fault report what each arm did.

Be honest about the outcome, including the uninteresting one: if both arms survive a fault,
say so plainly. The runtime's value is supposed to show up as "the no-runtime arm loses work,
duplicates an effect, or corrupts the workspace, and the runtime arm does not". If that does
not happen, the finding is that the fault is too weak or the claimed benefit is not real —
and either is worth knowing. Do not tune the scenario until the runtime looks good.

## Scale

Start with ONE repo, ONE planted bug, ONE agent, both arms. Get the scoring pipeline
trustworthy — especially the anti-cheat path — before adding anything. Then a handful of
bugs, then a few agents in parallel. Keep concurrency small: a few agents, not dozens, and
one shared gateway and Temporal on this box. The subscription quota is the binding
constraint, so a run that burns the day's quota to produce one number is a bad trade.

## What to report
The outcome table (per arm, per fault, with the five outcome kinds), the pass rate, the
wall time and model-call count per arm, how many attempts were `tampered` and what they
tried, and an explicit list of what this does NOT measure. Note especially any fault where
the two arms behaved identically.
