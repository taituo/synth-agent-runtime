# Review task: audit the specs and decisions, not the code

You are reviewing the work of a coordinating agent (Claude) that has been writing specs,
making design decisions, and verifying another agent's implementations on
`/home/tiny/projects/pisynth/synth-agent-runtime`. Nobody has checked ITS work. That is your
job. Be adversarial. A review that finds nothing is a failed review.

## What to read

- `/tmp/opencode/ROADMAP.md` — the standing work queue, ordering and rationale
- `/tmp/opencode/spec-artifact-egress.md` — artifact egress and handoff (the newest, least reviewed)
- `/tmp/opencode/spec-rung-parity.md` — synthetic vs real rung parity
- `/tmp/opencode/spec-quota-aware-retry.md` — retry against subscription quota limits
- `/tmp/opencode/spec-realistic-test-suite.md` — the six-track test suite
- `/tmp/opencode/bug-report-park-semantics.md`, `bug-report-waiting-spin.md`
- The repo itself: `git log` since 4df4de6, and the code those specs talk about.

## What to look for, in priority order

1. **Claims that were asserted but never measured.** The coordinator has a known failure
   mode here: it described a `../` path traversal as a security issue from reading the code,
   then measured it and found it was clamped, not escapable. Find the other places where a
   confident claim rests on reading rather than running. Check them by running something.
2. **Internal contradictions between specs.** One is already known and documented: the
   egress spec demanded "a reference, never bytes" while the `Artifact` type it lands in
   carries `data: unknown` inline. That one was caught. Find the ones that were not.
3. **Decisions made on the user's behalf that deserved more scrutiny.** Recent ones: symlinks
   preserved-with-validation rather than flattened; the real filesystem as the oracle for the
   synthetic rung; the judge deliberately last; priority lanes before multi-account routing.
   For each, is the stated reasoning actually sound, or does it just sound sound?
4. **Verification theatre.** The coordinator claims to verify by running tests and demanding
   "discriminating" assertions. Check whether its own checks could actually fail. Where it
   says it verified something, could that verification have passed on broken code?
5. **Things the roadmap omits.** What is missing that a careful engineer would expect —
   security, operability, cost, failure modes, data retention, the public repo's exposure?

## How to report

Write `/tmp/opencode/review-findings.md`. For each finding: what the claim was, where, why it
is wrong or weak, and the evidence — a command you ran and its output, not an opinion. Rank
by severity. State explicitly which claims you checked and found to be CORRECT, so the
coordinator knows what was actually examined versus skipped.

Do not fix anything. Do not push. Review only. Read-only on the repo: run tests and scripts,
but make no commits and change no tracked files.
