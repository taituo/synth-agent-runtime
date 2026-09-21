# Follow-ups from the independent review

An independent reviewer audited the coordinator's specs and decisions and found real defects.
Full findings: `/tmp/opencode/review-findings.md`. I re-verified the two severity-1 items
myself; both are correct. These are my errors, not yours. Fix them in this order.

## 1. The differential harness's "oracle" is not independent (severity 1)

`test/fixtures/rung-parity.ts:19-21` imports `escapesWorkspace`, `normalizeRelative` and
`workspaceError` from the synthetic rung's own policy and applies them in the "real
filesystem" arm at lines 82-83. So for anything path-policy related, the harness compares the
synthetic rung against itself. The `../` row of the parity table proves nothing — it is
exactly the circular test we removed from the fault matrix, in a new place.

Fix: the oracle arm must be raw `node:fs` with **no imports from `src/execution` or
`src/workspace`**. It does what the OS does: an absolute path writes at the absolute path, a
`..` that leaves the root leaves the root (run it inside a temp dir so that is safe), a
missing file is ENOENT. Then re-run the differential harness and report what NEW divergences
appear — there will be some, and that is the point. Add a lint or a test that fails if the
oracle ever imports from the implementation again.

## 2. Absolute paths are still silently rewritten (severity 1, sub-finding)

`workspace.write "/etc/passwd"` returns `ok:true` and the bytes land at `etc/passwd` inside
the workspace. `escapesWorkspace("/etc/passwd")` is `false` because it only inspects literal
`..` segments. This is the same "silent rewrite" class the parity work claimed to close, still
open, and structurally invisible to the current harness because both arms share the helper.

Decide and implement: either reject an absolute path with `WORKSPACE_PATH_ESCAPES`, or accept
it as an explicitly documented workspace-relative interpretation. My recommendation is reject,
because "success, and I wrote it somewhere other than you asked" is the failure class this
project keeps finding. Whichever you choose, the independent oracle must show the same
behaviour or the divergence must be documented.

## 3. My symlink decision was wrong in BOTH directions (severity 1)

I specified "preserve symlinks, reject those whose target escapes, using the same check as a
traversing write". Verified myself, that check gives:

    escapesWorkspace("/etc/passwd")     -> false   accepts the exact attack I said to reject
    escapesWorkspace("../other-dir/pm") -> true    rejects a REAL symlink in the pinned
                                                   commander fixture, corrupting the repo
                                                   the policy existed to protect

Corrected decision: resolve the target **relative to the link's own parent directory**, then
check whether the RESOLVED path is inside the workspace. `../other-dir/pm` from
`tests/fixtures/another-dir/` resolves inside and must be kept; `/etc/passwd` and a target
that climbs out resolve outside and must be rejected. Also specify: symlink chains (resolve
with a depth limit, reject cycles) and dangling links (a link whose target does not exist is
still a valid link — keep it, do not resolve-and-fail).

Note the reviewer's other correct point: there is currently no workspace effect that can
create a symlink at all, so "preserve symlinks" needs new API surface that my egress spec
never mentioned. Scope that explicitly before building it.

## 4. Source-backed symlink reads are ambiguous again (severity 1, sub-finding)

On a `TreeSource`-backed `MemoryWorkspace` (i.e. a real cloned repo), reading a symlink
returns `{ok:true}` with no output — indistinguishable from an empty file. That is precisely
the ambiguity the parity work set out to remove, still present for the fixture class Track 1
is built on. The generated harness never uses a `TreeSource`, so it cannot see this. Extend
the harness to cover source-backed workspaces and fix what it finds.

## 5. Contradictions in my own specs — I am fixing these, listed so you know

- "Artifacts must NEVER flow through Temporal history" vs keeping a bounded inline mechanism
  and calling a patch a handoff. The absolute "never" is wrong as written: the real rule is
  that content above a small explicit ceiling travels out of band, and anything below it may
  be inline. I am rewriting that section; build to the ceiling rule, not the absolute.
- The roadmap says the gym needs no judge while the egress spec justifies itself with the
  judge. Both are partly right: the gym's PASS/FAIL needs no judge, but ranking and triage of
  findings does. I am making that distinction explicit.

## 6. Do not re-close these without evidence
For each item, show the before/after the way you have been doing it: the failing state first,
then the fix. For item 1 in particular, the interesting output is the list of NEW divergences
a genuinely independent oracle reveals.
