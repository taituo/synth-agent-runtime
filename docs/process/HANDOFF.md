# Handoff — single entry point

**If you are a fresh Claude session, or the coordinator is gone: read this file, then
`/tmp/opencode/BRINGUP-PLAN.md` (its PROGRESS LOG at the end is the current state). Nothing
waits on the coordinator.**

## Who does what

- **`synth-orch` is the hub.** It coordinates, dispatches, and holds state in files. It does
  not wait for Claude. It escalates to the human owner only for owner decisions (see below).
- **`bringup-verify`** verifies independently. It re-runs everything claimed. Nobody writes to
  its file `bringup-verification.md`.
- **Claude (coordinator)** appears intermittently: verifies independently, relays owner
  decisions, writes specs. **Its context is finite and it will disappear mid-project.** Nothing
  may be blocked on it.

## Where everything is

| file | what |
|---|---|
| `synth-agent-runtime/docs/DIRECTION.md` | the architectural boundary — in the repo, survives everything |
| `BRINGUP-PLAN.md` | machine state (§2), known defects (§3), steps + gates (§4), PROGRESS LOG |
| `PHASE-1.md` | the current phase, five steps with a check each |
| `fix-rule.md` | fix / ask / leave-it-as-a-finding |
| `bringup-verification.md` | the verifier's log |

## The two machines

Develop on `tiny`. Verify and run on `big`:
`ssh -i <ssh-key> tiny@<big-host>` (internal 10.92.1.1).
The key announced as `<ssh-key-announced>` does not exist.

## What needs the human owner, and only that

1. Which harness gets the first real adapter (Phase 3).
2. Anything that changes the DIRECTION boundary.
3. Spending money: more machines, load tests at scale.
4. A fix that would make the run green rather than make the system work.

Everything else: decide it yourself, record why, keep going. A premise that collapses under
measurement is a result — report it instead of working around it.

## The rules that were learned by getting them wrong

- Attack it; do not read its tests.
- Run the control. A proof that only ever passes is not evidence.
- Check the call path, not just that the code exists and its tests pass.
- Verify the committed state in a separate worktree with `rm -rf dist` first.
- Never suppress errors in a verification command.
- Suspect your own probe first when a result confirms what you expected.
- A skip is not a pass.
- Say plainly when a result does not differentiate.
- Report numbers, not conclusions.
