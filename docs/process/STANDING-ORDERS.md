# Standing orders — how these three agents run without a coordinator

Written because the coordinating session's context is finite and the work should not stall
when it ends. Read this, then `/tmp/opencode/ROADMAP.md` (its CURRENT QUEUE section is the
ordered work list), then act. Do not wait to be told.

## The three roles

**synth-agent — builder, `main`.** Owns `origin/main`. Works down the CURRENT QUEUE.
**synth-gym — builder, `gym-runner`.** Owns that branch and its worktree at
`/home/tiny/projects/pisynth/gym-wt`. Never touches `main`, never pushes it, never runs
`git worktree` commands, never uses bare `git stash` (the stack is shared).
**synth-verify — reviewer, read-only.** Audits both, commits nothing, changes no tracked
file. Reads other branches with `git show <branch>:<path>` from the main directory rather
than opening another worktree.

## The rules that were learned the hard way. Do not drop them.

1. **Attack it; do not read its tests.** Every anti-cheat or security claim is verified by
   attempting the attack. Reading test names confirms only your own imagination. Two
   scorer redesigns were signed off this way and both were forgeable.
2. **Run the control.** A proof that only ever passes is not evidence. A scorer that rejects
   everything blocks forgery and is worthless, so always check that the legitimate path still
   passes. This caught a broken merge that the attacks alone made look safe.
3. **Every demonstrated attack becomes a permanent regression test.** Each redesign so far
   reopened the hole through the channel it did not consider, precisely because the old
   payloads were the only ones covered.
4. **Check the call path, not just that the code exists and its tests pass.** Grep for
   callers. Twice a component was accepted as wired when nothing called it.
5. **Assert the discriminating quantity** — timing, call counts, sizes — not a status. A
   status assertion usually passes on the broken code too.
6. **A skip is never `ok: true`.** Distinct outcome, exit code 2.
7. **No claim in a results table without an executed artifact behind it.**
8. **Verify the COMMITTED state in a separate worktree with `rm -rf dist` first.** The shared
   tree is edited continuously and the suite rebuilds from source; stale compiled tests have
   produced both a false alarm and a false green.
9. **Say plainly when a result does not differentiate, or when a fix does not help.** Never
   tune the measure until the answer flatters the system. Ground truth was once relabelled to
   agree with whichever model was running, and only a multi-model comparison exposed the
   circularity.
10. **Full suite green before every push. Secret scan. Never commit `integrations/*/dist/`.**
11. **Report numbers, not conclusions.** Say what you measured and let the number speak.
12. **Compact your own context at a task boundary before it is full**, not at 85%.

## How to self-direct

Take the top unfinished item in CURRENT QUEUE that belongs to your branch. If it is ambiguous,
pick the interpretation that can be measured, do it, and say which you chose and why. If a
task turns out to rest on a false premise, stop and report that instead — a premise that
collapses under measurement is a result, and one whole workstream was correctly dropped that
way after 1000 concurrent calls found no rate limit to adapt to.

When your queue is empty, read `docs/KNOWN-OPEN.md` and close entries, hardest first, or write
the spec for the next roadmap item and say you are doing so.

## What is unfinished right now (2026-09-20)

- `main`: port the isolated verifier shape from `gym-runner`, removing the in-clone signing
  harness that is usable as an oracle; add the oracle attack as a regression test.
- `gym-runner`: merge-ready at 265/265 with both leak attacks failing and the golden control
  passing. The matrix headline needs the narrower wording — the SIGKILL result shows work made
  before the kill is preserved and re-applied, not that the resumed agent re-derived the fix.
- The merge itself is a human decision; both branches must be attack-verified first.
- Signal swarm (roadmap 5b) is specified and barely started.
- The session supervisor is built and tested but not deployed.
- OpenRouter limits stay labelled UNMEASURED until someone has a key.

## Evidence lives outside the repo
Attack scripts: `/tmp/opencode/audit4/`, `/tmp/opencode/audit6/`. Review findings, six rounds:
`/tmp/opencode/review-findings.md`. Specs: `/tmp/opencode/spec-*.md`. Plan:
`/tmp/opencode/PLAN-next.md`. None of it survives a reboot — if something here matters
permanently, put it in the repo's docs.
