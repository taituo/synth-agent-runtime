# Reality check: the whole project, not a commit

Every review so far has been narrow — a specific claim, a specific commit, an attack on a
specific mechanism. That has worked well and found real defects. This one is different: step
back and assess the project as a whole, the way an experienced engineer would after being
handed the repo cold and asked "is this what it says it is, and is it worth continuing?"

Repo: /home/tiny/projects/pisynth/synth-agent-runtime (read `main`, and `gym-runner` via
`git show gym-runner:<path>`). Context worth reading: `docs/`, `CHANGELOG.md`,
`/tmp/opencode/ROADMAP.md`, `/tmp/opencode/review-findings.md` (seven rounds of your own
earlier findings), `/tmp/opencode/MAP.md`.

## The questions

1. **Is the project what its documentation claims?** Where is the gap between what the docs
   assert and what the code does? You already found one large instance — the isolation claim —
   so look for the pattern rather than the instance.
2. **Is the architecture sound, or is it accumulating complexity faster than it earns it?**
   Name anything that exists because it seemed necessary rather than because something needed
   it. Dead abstractions, options nobody sets, layers with one implementation.
3. **What is the biggest risk nobody is currently looking at?** Not the known-open list —
   something structural that has stayed invisible because everyone has been busy with the
   thing in front of them.
4. **Is this worth building at all?** The uncomfortable question. Temporal already provides
   durable execution; several agent frameworks already exist. What does this repo actually add
   that you cannot get by using those directly, and is that delta big enough to justify the
   code? A defensible answer either way is useful; a polite one is not.
5. **If you had to cut half of it, what would you cut?** That usually reveals what the project
   really is.
6. **What is the quality of the evidence overall?** Seven review rounds produced a lot of
   measurement. Is the body of evidence actually load-bearing, or is it thick in the places
   that were easy to measure and thin where it matters?

## How to answer

Rank everything by confidence and say so explicitly: **SOLID** when you can point at code or
an executed result, **LIKELY** when it is a well-founded read, **SPECULATIVE** when it is a
hunch worth recording but not acting on. The coordinator expects false positives from this
exercise and would rather see a speculative item labelled than omitted — but an unlabelled
guess presented as a finding is worse than silence.

Prefer few, well-evidenced points over a long list. Where you can check something by running
it, run it. Where you are reasoning from reading, say so.

Write to `/tmp/opencode/reality-check.md`. Read-only on the repo: no commits, no changes to
tracked files.
