# Synthetic rung fidelity (rung parity)

The fidelity ladder promises that the synthetic rung (fidelity 0,
`MemoryWorkspace`, no filesystem) is a fast, cheap simulation of the real rung
(gVisor sandbox, real filesystem). That promise only holds where the two agree.
A simulation that lies exactly where errors occur is worse than none: it
produces confident wrong answers instead of obvious failures.

## The oracle and the harness

The **real filesystem is the oracle**. `test/rung-parity.test.ts` runs the same
generated workspace effect sequence (seeded, over a small path alphabet with
nested paths, a path reused as file then directory, unusual names, and `..`
segments) against `SyntheticExecutor` and against `RealFsExecutor` (a real
temp-directory filesystem), then diffs the per-effect `ok`/`error`/output and
the final listing. `test/fixtures/rung-parity.ts` is the harness. Both rungs
return the same **shared error vocabulary** (`WORKSPACE_NOT_FOUND`,
`WORKSPACE_NOT_DIRECTORY`, `WORKSPACE_IS_DIRECTORY`, `WORKSPACE_PATH_ESCAPES`)
from `src/execution/workspace-errors.ts`, which is what makes them comparable.

## Divergences found and closed

| operation | before (synthetic) | after (both rungs) |
|---|---|---|
| `read` missing path | `{ok:true}`, no output | `WORKSPACE_NOT_FOUND:<path>` |
| `delete` missing path | `{ok:true}` | `WORKSPACE_NOT_FOUND:<path>` |
| `list` missing directory | `{ok:true, output: []}` | `WORKSPACE_NOT_FOUND:<path>` |
| write `a/b.txt`, delete `a`, read `a/b.txt` | returned the content | gone (recursive delete) |
| write under a file path (`f.txt/child`) | `{ok:true}` | `WORKSPACE_NOT_DIRECTORY:<path>` |
| `read`/`list`/`delete` under a file path | `NOT_FOUND` | `WORKSPACE_NOT_DIRECTORY:<path>` |
| write where a directory exists | `{ok:true}` | `WORKSPACE_IS_DIRECTORY:<path>` |
| implicit directory after its last child is deleted | forgotten | kept (matches a real empty dir) |
| path normalising to the root (`..`, `.`, `/`) | **threw** `Cannot write workspace root` | an `EffectResult`: `WORKSPACE_IS_DIRECTORY` for read/write/delete, success for `list` |
| `../escape.txt` | silently rewritten to `escape.txt`, `ok:true` | rejected: `WORKSPACE_PATH_ESCAPES:<path>` |

`normalizeRelative` pops `..` segments, so the workspace was never escapable —
the earlier framing as a security hole was wrong. The real defect was a **silent
rewrite**: a caller asking to write outside the workspace got `ok:true` and the
bytes landed at a different in-workspace path. Both rungs now reject such paths
loudly instead.

## Accepted differences (deliberate, with consequences)

- **`..` is rejected, not clamped.** `normalizeRelative` still clamps for path
  resolution elsewhere (e.g. the sandbox workspace sync), but a workspace
  *effect* through the broker returns `WORKSPACE_PATH_ESCAPES` rather than
  succeeding at a rewritten path. Consequence: a caller that relied on `..`
  being silently normalised now gets an error — which is the point.
- **No process execution.** `process.exec` returns `ESCALATION_REQUIRED` and
  escalates to the real rung.
- **No filesystem metadata.** Modes, ownership, mtimes and symlink creation are
  not modelled; a symlink that came from a `TreeSource` is reported, but there
  is no effect to create one. Do not use the synthetic rung to test permissions
  or symlink behaviour.
- **Directories exist only implicitly.** There is no `mkdir` effect; a directory
  exists because something was written beneath it. An empty directory cannot be
  created on the synthetic rung.
- **Single writer.** `MemoryWorkspace` is in-process; it does not model
  concurrent writers or cross-process visibility.

## What can be trusted on the synthetic rung

Workspace read/write/delete/list semantics — including nested paths, unusual
filenames, missing-path errors, recursive directory deletion, `ENOTDIR`/`EISDIR`
equivalents and path confinement — match a real filesystem and are covered by
the differential harness. Workloads that need real processes, real filesystem
metadata, symlink creation, or concurrent writers must escalate to the real rung.
