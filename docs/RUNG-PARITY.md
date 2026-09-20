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
segments) against `SyntheticExecutor` and against `RealFsOracle`
(`test/fixtures/real-fs-oracle.ts`: raw `node:fs`, no implementation imports),
then diffs the per-effect `ok`/`error`/output. The oracle returns raw errno, so
comparability comes from the harness's `categoryOf` mapping in
`test/fixtures/rung-parity.ts`, not from a shared vocabulary on both sides; the
synthetic rung's own vocabulary (`WORKSPACE_NOT_FOUND`,
`WORKSPACE_NOT_DIRECTORY`, `WORKSPACE_IS_DIRECTORY`, `WORKSPACE_PATH_ESCAPES`)
lives in `src/execution/workspace-errors.ts`.

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
| absolute path (`/etc/passwd`) | silently rewritten to `etc/passwd`, `ok:true` | rejected: `WORKSPACE_PATH_ESCAPES:<path>` |

`normalizeRelative` pops `..` segments, so the workspace was never escapable —
the earlier framing as a security hole was wrong. The real defect was a **silent
rewrite**: a caller asking to write outside the workspace (via `..` **or an
absolute path**) got `ok:true` and the bytes landed at a different in-workspace
path. The synthetic rung now rejects both loudly instead.

### The oracle is independent

`test/fixtures/real-fs-oracle.ts` uses raw `node:fs` and imports **no value**
from `src/execution` or `src/workspace`; `test/rung-parity.test.ts` asserts that.
An earlier version applied the synthetic rung's own `escapesWorkspace` /
`normalizeRelative` in the "real" arm, so the path-policy rows compared the
synthetic rung against itself — the same circular test removed from the fault
matrix. With a genuinely independent oracle, one further divergence appeared:
a write under a file path yields the OS `EEXIST` (the oracle's `mkdir -p` hits
the file) where the synthetic rung reports `WORKSPACE_NOT_DIRECTORY`. That is a
vocabulary mismatch, mapped to the same category in the harness's comparison
layer, not a behavioural difference.

### Documented divergence: confinement

The raw OS really does escape the workspace (`../escape.txt` writes outside the
root; an absolute path writes where it says), while the synthetic rung rejects
such paths. This is deliberate. Note the sandbox does **not** execute
`workspace.*` effects at all (`KubernetesExecutor.canExecute` is only
`process.exec`; the broker runs workspace effects on `SyntheticExecutor`), and
the sandbox's own path helpers clamp absolute paths rather than reject them, so
"the sandbox confines" is only loosely true — the confinement is the synthetic
rung's policy. The harness classifies these as `escape` divergences and asserts
that **no other** divergence exists, so a new unexpected one still fails.

## Symlink semantics (decided)

**`workspace.read` follows symlinks** — it means `readFile`, not `readlink`.
This is the decision that makes the synthetic rung and the independent oracle
agree: a real filesystem's `readFile` follows a link and yields the target's
content, so the synthetic rung does the same. A `TreeSource` stores a symlink as
a blob whose *content is the target string*; the workspace uses that string to
resolve the path (relative to the link's parent) and then reads the resolved
path, following a chain with a depth limit. Consequences:

- `stat` reports `kind: "symlink"`, and `read` of a link to a non-empty target is
  non-empty — so a symlink read is never indistinguishable from an empty file.
- A **dangling** link reads as absent (`ENOENT`-equivalent), and a **cyclic**
  chain is depth-limited and also reads as absent. Creation still keeps a
  dangling link (it is a valid link); only reading it fails.
- An earlier version returned the link's target *text* (the git blob content),
  which diverged from the oracle; that was superseded. The commander fixture
  chain `another-dir/pm -> ../other-dir/pm -> ../pm` is followed to the file
  `tests/fixtures/pm`, and the test asserts the synthetic and oracle reads are
  byte-identical.

## Accepted differences (deliberate, with consequences)

- **`..` and absolute paths are rejected, not clamped.** `normalizeRelative`
  still clamps for path resolution elsewhere (e.g. the sandbox workspace sync),
  but a workspace *effect* through the broker returns `WORKSPACE_PATH_ESCAPES`
  rather than succeeding at a rewritten path. Consequence: a caller that relied
  on `..` or an absolute path being silently normalised now gets an error —
  which is the point.
- **No process execution.** `process.exec` returns `ESCALATION_REQUIRED` and
  escalates to the real rung.
- **No file modes, ownership or mtimes.** A `workspace.symlink` effect and
  `MemoryWorkspace.symlink` now exist, so symlinks can be created and read; but
  permission bits, ownership and mtimes are still not modelled. Do not use the
  synthetic rung to test permissions.
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
