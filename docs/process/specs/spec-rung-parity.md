# Spec: make the synthetic rung a faithful simulation of the real one

Repo: /home/tiny/projects/pisynth/synth-agent-runtime. Push to origin/main.
Start after the quota-aware retry work. Small pieces, failing-first, live proofs.

## Why this matters more than it looks

The fidelity ladder's promise is that the synthetic rung (fidelity 0, `MemoryWorkspace`, no
filesystem) is a FAST, CHEAP simulation of the real one (gVisor sandbox, real fs). If that
holds, large swarm runs can happen in memory for almost nothing and escalate only where real
execution is genuinely needed. If it does not hold, every cheap run teaches us — and any
agent we drive with it — something that is false on the real rung. A simulation that lies
exactly where errors occur is worse than no simulation, because it produces confident wrong
results instead of obvious failures.

## Measured divergences (I ran these against the current build; they are facts, not guesses)

Every one of these returns `ok: true` from `ExecutionBroker`/`SyntheticExecutor` where a real
filesystem would fail:

| operation | synthetic | real filesystem |
|---|---|---|
| `workspace.read` of a missing path | `{ok:true}`, no output | ENOENT |
| `workspace.delete` of a missing path | `{ok:true}` | ENOENT |
| `workspace.list` of a missing directory | `{ok:true, output: []}` | ENOENT |
| `workspace.write` `a/b.txt`, `delete` `a`, then `read` `a/b.txt` | **returns the content** | gone |
| `workspace.write` to `f.txt/child` where `f.txt` is a file | `{ok:true}` | ENOTDIR |
| `workspace.write` to `../escape.txt` | `{ok:true}` | confined/rejected by the sandbox |

Two consequences worth stating plainly:
- A caller cannot distinguish "the file is empty" from "the file does not exist". That is a
  silent wrong answer, the worst failure class.
- Deleting a directory does not delete its children, so the synthetic rung can report state
  that is impossible on a real filesystem.

## The work

### 1. Differential harness (do this first, it is the deliverable)

A harness that runs the SAME generated effect sequence against both rungs and diffs the
observable outcome: per-effect `ok`/`error`, output bytes, and the final workspace listing.
Reuse the Track 3 seeded-generator approach: random sequences of write/read/delete/list/exec
over a small shared path alphabet (including nested paths, a path that is a file and a
directory in turn, unusual names from Track 1, and `..` segments). Print the seed; on a
divergence, shrink to a minimal sequence and keep it as a permanent regression case.

The real rung needs the cluster and a git-capable image, exactly like `fault-rungs.ts`
(`SYNTH_EXECUTOR_IMAGE` pinned by digest). Absent that, SKIP as a distinct outcome — exit
code 2, never `ok:true`. That rule is now established in this repo; follow it.

### 2. Decide the oracle, then close the gaps

The real filesystem is the oracle: the synthetic rung is a simulation OF it, so where they
differ, synthetic changes — unless there is a stated reason not to. For each divergence
above and each one the harness finds, do one of exactly two things, and record which:

- **Fix the synthetic rung** so it matches (missing-path errors, recursive delete semantics,
  ENOTDIR-equivalent, path confinement). Prefer a shared error vocabulary over raw errno
  strings, so both rungs return the same `error` value for the same condition — that is what
  makes the two comparable at all.
- **Document it as an accepted difference** in docs, with the reason and the consequence for
  anyone using the synthetic rung. "Not worth fixing" is a legitimate answer; leaving it
  undocumented is not.

Correction on the `../` row — I checked `normalizeRelative` (src/workspace/source.ts:27)
after writing the table above, and my first characterisation was wrong. It pops `..`
segments, so the workspace is NOT escapable:

    "../../etc/passwd" -> "etc/passwd"      "a/../../b" -> "b"
    "/abs/path"        -> "abs/path"        ".."        -> ""

So this is not a security hole. The real divergence is a SILENT REWRITE: a caller asking to
write outside the workspace gets `ok:true` and the bytes land at a different in-workspace
path than the one requested. A real filesystem either fails or writes somewhere else
entirely; neither answer is "success, and I put it somewhere other than where you asked".
Decide whether an escaping path should be rejected rather than clamped, and pin it with a
test either way.

Related edge case for the harness: a path that normalises to the empty string (`".."`, `"."`,
`"/"`) hits the "Cannot write workspace root" throw in `write`/`delete` — an exception, not
an `EffectResult`. That is a third behaviour, distinct from both ok and a returned error, and
it should be reconciled: the broker's contract is a result, not a throw.

### 3. Say what the synthetic rung is good for

When the divergences are closed or documented, write a short section in the docs stating
honestly which workloads can be trusted on the synthetic rung and which cannot. That
sentence is the thing that lets us run cheap mass simulations without fooling ourselves.

## Out of scope
Priority lanes, new executors, and any change to the Kubernetes rung's behaviour. If the
harness shows the REAL rung is the wrong one in some case, report it — do not silently
change the real rung to match the simulation.

## Report back
The divergence table (before/after), which ones you fixed vs documented and why, the seeds of
any regression cases you kept, and the commit SHAs.
