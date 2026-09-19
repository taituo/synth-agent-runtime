# Pi Synthetic Agent Runtime — Design Spec

**Status:** Draft v0.2  
**Target:** Pi (`earendil-works/pi`)  
**Upstream baseline inspected:** `main` at `36b60d2e8985899743c4cf5bd5f8929832a3f05d` (2026-09-18)  
**Primary goal:** Run a real LLM coding agent against a fully synthetic, in-memory machine while preserving the normal `read` / `write` / `edit` / `bash` tool contract. The same agent instance must support interactive and unattended operation.

---

## 1. Key upstream finding

Pi already has almost exactly the seam this experiment needs.

In `packages/agent`, Pi defines a backend-independent execution abstraction:

- `FileSystem`
- `Shell`
- `ExecutionEnv` = filesystem + shell

The harness-native `read`, `write`, `edit`, and `bash` tools operate through an `ExecutionEnv` supplied in their tool context. The real-machine implementation is `NodeExecutionEnv`.

The experimental mini worker already wires the pieces together in the desired shape:

```text
NodeExecutionEnv
      │
      ▼
{ env: executionEnv }
      │
      ▼
read / write / edit / bash
      │
      ▼
AgentHarness
```

Therefore the first prototype does **not** need fake tool responses and does **not** need to rewrite Pi's core tool behavior. It should implement a new `MemoryExecutionEnv` satisfying the existing `ExecutionEnv` contract and inject it where Pi currently injects `NodeExecutionEnv`.

### Relevant Pi source paths

```text
packages/agent/src/harness/types.ts
packages/agent/src/harness/env/nodejs.ts
packages/agent/src/harness/tools/read.ts
packages/agent/src/harness/tools/write.ts
packages/agent/src/harness/tools/edit.ts
packages/agent/src/harness/tools/bash.ts
packages/agent/src/harness/tools/path-utils.ts
packages/coding-agent/src/experimental/mini/worker/run.ts
packages/coding-agent/src/experimental/micro/tools.ts
packages/coding-agent/src/core/agent-session.ts
```

A particularly useful upstream property is that `AgentSession` is already the shared lifecycle layer for interactive, print, and RPC modes. The synthetic machine should therefore be an execution backend, **not a new agent type**.

---


## 1.1 Inference layer: use Pi directly with OpenCode Go

A second upstream finding simplifies the hybrid design further: **current Pi already ships a built-in `opencode-go` provider**. The provider lives in `packages/ai/src/providers/opencode-go.ts`, uses `OPENCODE_API_KEY`, supports Pi's Anthropic/OpenAI-compatible API adapters, and wraps requests with OpenCode's stable session header. Current OpenCode Go documentation also lists Pi as a validated client.

Therefore the first synthetic-runtime prototype should **not copy OpenCode provider code into Pi and should not proxy through an OpenCode process merely to access the subscription**. Keep Pi as the harness and use its existing OpenCode Go provider directly.

```text
Pi AgentHarness
    |
    +-- execution --> MemoryExecutionEnv
    |
    +-- inference --> RoutingModels (ours)
                         |
                         +--> Pi ModelRuntime
                                  |
                                  +--> opencode-go
                                  +--> openai
                                  +--> anthropic
                                  +--> openrouter
                                  +--> other Pi providers
```

The custom part should be a small **inference router above Pi's `Models` interface**, not a fork of OpenCode's transport implementation. Each logical agent instance receives an `InferenceProfile` such as `super`, `worker-cheap`, `reviewer`, or `summarizer`. The profile contains an ordered list of provider/model routes. Pi remains responsible for catalogs, authentication, request formatting, provider quirks, and OpenCode Go's session header.

The first fallback implementation should be conservative: retry another route only before semantic model output has been exposed. Once text, thinking, a tool call, or a completed response is emitted, the route is committed for that request. Later, the synthetic workspace can support stronger rollback-and-replay semantics by snapshotting the world before each turn.

A prototype router and integration notes are provided alongside this spec in `pi-hybrid-prototype/`.

## 2. Product concept

The runtime unit is:

```text
SyntheticAgent
├── real LLM inference
├── real conversation/session
├── real Pi agent loop
├── real Pi tools
└── MemoryMachine
    ├── in-memory filesystem
    ├── synthetic cwd/env
    ├── deterministic shell
    ├── command registry
    ├── virtual clock
    ├── snapshots/forks
    └── artifact exporter
```

From the model's perspective, it is using an ordinary coding machine:

```text
read("src/auth.ts")
write("src/auth.ts", ...)
edit(...)
bash("grep -R refresh src")
bash("git diff")
```

The implementation performs no project-file reads/writes on the host after the initial world is created and launches no child processes for synthetic shell commands.

The LLM must not need to know whether its environment is memory, container, VM, or real host.

---

## 3. Core invariant

> **The agent sees a machine-shaped protocol; the runtime decides what machine exists.**

For synthetic mode:

```text
LLM tool call
    │
    ▼
Pi built-in tool
    │
    ▼
ExecutionEnv
    │
    ▼
MemoryExecutionEnv
    │
    ├── MemoryFS
    └── MemoryShell
```

No tool output should be invented by another LLM. Environment behavior is deterministic program logic.

---

## 4. Real vs synthetic boundary

### Real

- LLM inference / provider calls
- Pi's agent loop
- conversation state
- user steering
- task input
- final agent response
- artifact produced at completion
- optional later validation in a real sandbox

### Synthetic

- project filesystem
- cwd
- environment variables visible to commands
- shell commands supported by the synthetic command registry
- temp files/directories
- time exposed by environment tools/commands
- Git working-tree view implemented by the runtime
- eventually selected HTTP/service calls

### Explicitly outside v0

- arbitrary native binaries
- package managers
- compilers/interpreters
- Docker
- kernel semantics
- arbitrary TCP/UDP networking
- full POSIX compatibility

Unsupported operations fail explicitly; they do not silently touch the host.

---

## 5. Architecture

```text
                ┌──────────────────────────┐
                │ Interactive TUI / RPC    │
                │ or unattended controller │
                └─────────────┬────────────┘
                              │
                              ▼
                      Pi Agent Session
                              │
                              ▼
                        AgentHarness
                              │
                  real read/write/edit/bash
                              │
                              ▼
                      ExecutionToolContext
                        { env: machine }
                              │
                              ▼
                    MemoryExecutionEnv
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
                 MemoryFS           MemoryShell
                    │                   │
                    └─────────┬─────────┘
                              ▼
                         World State
                              │
                 ┌────────────┼────────────┐
                 ▼            ▼            ▼
              snapshot       fork       artifact
```

A later validator can materialize an artifact into a real K8s/gVisor/microVM environment, but that is deliberately outside the first milestone.

---

## 6. Do not couple session persistence to the synthetic filesystem

Pi's experimental mini worker currently creates one `NodeExecutionEnv` and uses it both for:

1. the coding tools; and
2. `JsonlSessionRepo` storage.

Synthetic mode should split these responsibilities immediately:

```text
sessionStoreEnv = NodeExecutionEnv or durable backend
workspaceEnv    = MemoryExecutionEnv
```

Then:

```text
JsonlSessionRepo({ fileSystem: sessionStoreEnv })
AgentHarness({ toolContext: { env: workspaceEnv } })
```

This prevents agent conversation durability from depending on an ephemeral RAM workspace and makes later Temporal/durable integration straightforward.

---

## 7. `MemoryExecutionEnv`

Implement Pi's existing `ExecutionEnv` interface.

Suggested API in addition to the Pi contract:

```ts
class MemoryExecutionEnv implements ExecutionEnv {
  readonly cwd: string

  static fromSeed(seed: WorkspaceSeed, options?: MemoryEnvOptions): MemoryExecutionEnv

  snapshot(): MemorySnapshot
  fork(): MemoryExecutionEnv
  diff(base?: MemorySnapshot): WorkspaceDiff
  exportArtifact(): WorkspaceArtifact
}
```

The Pi-facing methods remain exactly the existing `FileSystem` and `Shell` contract.

### v0 filesystem methods

Pi currently expects the environment to support operations equivalent to:

```text
absolutePath
joinPath
readTextFile
openTextLineReader
readTextLines
readBinaryFile
writeFile
appendFile
renameFile
fileInfo
listDir
canonicalPath
exists
createDir
remove
createTempDir
createTempFile
cleanup
```

The goal is compatibility with Pi's existing tools, not a new synthetic-only tool API.

---

## 8. In-memory filesystem model

Start simple. Do not implement a virtual kernel.

```ts
type NodeId = string

type VNode =
  | { kind: "file"; bytes: Uint8Array; mtimeMs: number }
  | { kind: "directory"; children: Map<string, NodeId>; mtimeMs: number }
  | { kind: "symlink"; target: string; mtimeMs: number }
```

For v0, symlinks may be either supported minimally or rejected with Pi's `not_supported` file error. If symlinks are disabled, `canonicalPath()` is just normalized identity for existing paths.

### Path rules

Use one synthetic namespace regardless of host OS:

```text
/workspace                 root project
/tmp                       synthetic temp namespace
```

Default `cwd`:

```text
/workspace
```

Path normalization must reject traversal outside the virtual root.

```text
../../host/etc/passwd
→ FileError(permission_denied | invalid)
```

No host path should ever be returned to the model.

### Encoding

Files are stored as bytes. Text methods decode/encode UTF-8. This preserves compatibility with Pi's binary read API and avoids a later migration from `Map<string,string>`.

---

## 9. Initial world seeding

The agent runtime itself must not read the real repository during execution.

World creation is an explicit separate step:

```text
Repo importer / caller
        │
        ▼
WorkspaceSeed
        │
        ▼
MemoryExecutionEnv.fromSeed(...)
```

Possible seed formats:

```ts
interface WorkspaceSeed {
  baseRevision?: string
  files: Array<{
    path: string
    bytes: Uint8Array
    mode?: number
  }>
}
```

For the first prototype the caller may build the seed from a real checkout. Later it could come from Git blobs, an object store, a tar snapshot, a database, or another synthetic world.

Once instantiated, the synthetic agent only sees the in-memory copy.

---

## 9.1 Dynamic Git-backed source: shallow + sparse without checkout

The preferred seed model is no longer “load a whole checkout into RAM first.” Treat `/workspace` as a **lazy immutable base source plus a mutable in-memory overlay**.

```text
Git remote / snapshot service
          │
          │ metadata + blobs on demand
          ▼
   VirtualTreeSource
          │
          ├── immutable base commit
          │
          ▼
 MemoryExecutionEnv
          │
          ├── RAM overlay writes
          ├── RAM tombstones
          └── RAM temp files
```

The Pi tools still see an ordinary filesystem. On a read miss, `MemoryExecutionEnv` asks the source for that path, returns the bytes to the tool, and optionally caches them in process memory. Writes never go back to the source.

The source contract should be deliberately small:

```ts
interface VirtualTreeSource {
  revision(): Promise<WorkspaceRevision | undefined>
  stat(path: string): Promise<VirtualSourceInfo | undefined>
  listDir(path: string): Promise<readonly VirtualSourceInfo[]>
  readFile(path: string): Promise<Uint8Array>
  listFiles?(): AsyncIterable<string>
}
```

A Git source is therefore **shallow by construction**: it can expose exactly one immutable commit and no history. It can also be **sparse by policy**: only selected path prefixes and their ancestors are visible. This is better for the synthetic runtime than faithfully reproducing `.git`, because the agent normally needs a tree snapshot, not Git’s local object database.

### First concrete adapter: GitHub commit snapshot

The prototype implements `GitHubSnapshotSource` using GitHub’s API. It resolves a ref once, then demand-pages directory metadata and blobs. It creates no checkout and no `.git` directory.

```text
PI_SYNTH_GITHUB_REPO=owner/repo
PI_SYNTH_GITHUB_REF=main
PI_SYNTH_GITHUB_SPARSE=src,packages/foo,package.json
```

`PI_SYNTH_GITHUB_SPARSE` is optional. When supplied, unrelated paths are invisible. File content is fetched only when a tool actually reads it. This gives the experiment a useful dynamic mode even for very large repositories.

Later adapters can implement the same interface using Git smart HTTP / `isomorphic-git`, GitLab, Bitbucket, an object store, a database, or another agent’s snapshot. The Pi harness and synthetic shell do not change.

### Overlay semantics

For `/workspace/path`:

```text
read:
  RAM overlay -> deletion tombstone -> immutable source

write:
  RAM overlay only

delete:
  tombstone only

list:
  source children + overlay children - tombstones
```

This is the core “dynamic system” primitive. An agent can work on a repository much larger than its materialized working set while the synthetic machine still owns all mutable state.

## 10. Synthetic shell

Pi's existing `bash` tool should remain unchanged. `MemoryExecutionEnv.exec()` implements the shell underneath it.

### Requirement

```text
bash("cat src/a.ts")
```

must observe the same state as:

```text
read("src/a.ts")
```

and a `write`/`edit` call must immediately affect later shell commands.

### v0 command grammar

Do not implement Bash. Implement a useful deterministic subset:

```text
command
command ; command
command && command
command || command
command | command
command > file
command >> file
```

Quoting/escaping should support the ordinary forms coding agents commonly emit:

```text
'...'
"..."
\ escapes
$VAR       (simple environment expansion)
```

Defer command substitution, functions, loops, jobs, process substitution, glob edge cases, etc.

### v0 command registry

Prioritize commands coding agents use for inspection and text manipulation:

```text
pwd
ls
cat
head
tail
wc
grep
find
echo
printf
mkdir
rm
cp
mv
touch
sort
uniq
diff
true
false
test / [ ]
sed          limited substitution/print subset
```

Add synthetic `git` as a first-class command family rather than trying to run real Git.

### Unsupported command behavior

Never fall through to the host.

```text
$ cargo test
synthetic-shell: cargo: command not available in synthetic environment
exit 127
```

This is a feature: it tells the agent that real validation is required instead of accidentally crossing the boundary.

---

## 11. Synthetic Git view

Do not run the real `git` executable and do not require a `.git` directory. The immutable `VirtualTreeSource` already represents `HEAD`; the in-memory overlay represents the working tree. Synthetic Git derives its answers directly from those two states.

The prototype implements:

```text
git status --short
git status
git diff
git diff --stat
git diff -- <path>
git ls-files
git rev-parse HEAD
git branch --show-current
git show HEAD:<path>
```

This is enough for a coding agent to orient itself, inspect the baseline, and review its own edits. `git diff` is generated against the immutable source bytes; new/deleted files are represented by the overlay/tombstones.

Branching and committing inside the shell remain unnecessary initially because the runtime’s native `snapshot()` and `fork()` are the stronger primitive. A later `commit()` operation can simply produce a content-addressed workspace artifact rather than emulating all local Git internals.

---

## 12. Shell output compatibility

Pi's harness `bash` tool already expects streaming/bounded output via `Shell.exec()`.

`MemoryExecutionEnv.exec()` must therefore honor:

- timeout/abort checks;
- combined stdout/stderr ordering;
- exit code;
- bounded capture;
- `onUpdate` callbacks;
- optional spill semantics.

For synthetic mode, a "spill file" is also an in-memory file under `/tmp`; it must never become a host temp file.

Because synthetic commands are in-process, progress updates can normally be emitted after each pipeline/command stage rather than after OS stream chunks.

---

## 13. Determinism

The environment should be deterministic even though LLM inference is not necessarily deterministic.

World options:

```ts
interface MemoryEnvOptions {
  cwd?: string
  clock?: VirtualClock
  env?: Record<string,string>
  randomSeed?: string
}
```

Deterministic surfaces:

- temp names
- modification timestamps
- command ordering
- directory listing order
- synthetic environment variables
- error messages/codes where practical

This gives reproducible tool behavior and enables eventual replay/evaluation.

---

## 14. Snapshot and fork

### v0

A deep clone is acceptable.

```ts
const fork = machine.fork()
```

### later

Move to copy-on-write/persistent structures:

```text
Base S0
├── Worker A delta
├── Worker B delta
└── Worker C delta
```

This is central to the later super/sub topology, but should not complicate v0.

---

## 15. Artifact output

The synthetic run should end in a real, deterministic artifact rather than "files somewhere in RAM".

```ts
interface WorkspaceArtifact {
  worldId: string
  baseRevision?: string
  createdAt: number

  changedFiles: Array<{
    path: string
    kind: "add" | "modify" | "delete"
    content?: Uint8Array
  }>

  unifiedDiff?: string
  requestedValidation?: string[]
  toolTrace?: ToolTraceSummary
}
```

The artifact is the boundary that a real validator, superagent, CI workflow, or human can consume.

Materialization later becomes:

```text
WorkspaceArtifact
      │
      ▼
real worktree / K8s / gVisor / microVM
      │
      ▼
real tests/build
```

---

## 16. Interactive and unattended are the same runtime

Do not create `InteractiveSyntheticAgent` and `BackgroundSyntheticAgent`.

The agent/session is identical. Only clients differ.

```text
                 SyntheticAgentSession
                        │
             ┌──────────┴──────────┐
             │                     │
             ▼                     ▼
       interactive client      unattended driver
       TUI / RPC / desktop     Temporal / script
```

Required lifecycle operations at the wrapper layer:

```text
prompt
steer
followUp
subscribe events
waitUntilIdle
abort
snapshot workspace
export artifact
```

Pi's `AgentSession` already has event subscription and steering/follow-up concepts; the prototype should reuse these semantics rather than invent another conversation controller.

---

## 17. Recommended Pi integration path

### Phase A — fastest proof: `packages/agent` + mini worker

Add:

```text
packages/agent/src/harness/env/memory.ts
packages/agent/src/harness/env/memory-fs.ts
packages/agent/src/harness/env/memory-shell.ts
packages/agent/src/harness/env/memory-git.ts
```

Then modify the experimental mini worker from conceptually:

```ts
const executionEnv = new NodeExecutionEnv({ cwd })
```

to:

```ts
const workspaceEnv = MemoryExecutionEnv.fromSeed(seed, { cwd: "/workspace" })
const sessionEnv = new NodeExecutionEnv({ cwd: sessionStorageDir })
```

and wire:

```text
JsonlSessionRepo → sessionEnv
read/write/edit/bash → workspaceEnv
```

This is the shortest path because the mini worker already uses Pi's harness-native `ExecutionEnv` tools directly.

### Phase B — preserve the full normal Pi TUI

There are two viable paths.

**B1. Move/bridge normal coding-agent built-ins onto `ExecutionEnv`.**  
This is architecturally clean but is a larger upstream-style refactor.

**B2. Add a synthetic operations adapter.**  
The normal coding-agent's tools already expose pluggable operation interfaces (`ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, and similar interfaces for list/grep/find). Adapt `MemoryExecutionEnv` to these operations and inject/override those tool definitions.

B2 is the better near-term fork because it preserves the existing interactive UI with minimal changes.

---

## 18. Host-leak prevention

Replacing `read/write/edit/bash` is necessary but not sufficient if the claim is "the agent's project world is entirely synthetic."

Potential host-touching surfaces in full Pi include:

- project context/resource loading (`AGENTS.md`, skills, prompts, themes);
- extensions, which are trusted executable TypeScript;
- user `!` shell commands;
- any additional tool added by an extension;
- session persistence;
- HTML/session export paths.

For the first proof, instantiate the low-level harness with explicitly supplied prompt/resources and only the four execution tools. This gives the cleanest isolation claim.

For a later full-TUI `--synthetic` mode:

```text
project context loader → synthetic FileSystem
agent tools            → synthetic ExecutionEnv
session storage        → separate trusted persistence backend
user ! commands        → disabled or explicitly host-marked
extensions             → trusted control-plane only / allowlisted
```

The model-provider network path remains real and is outside the synthetic machine.

---

## 19. Security invariant tests

The most important tests are negative tests.

1. A model command attempting `/etc/passwd` cannot read host `/etc/passwd`.
2. `write("/tmp/x")` only creates synthetic `/tmp/x`.
3. `bash("touch /tmp/x")` and `read("/tmp/x")` see the same synthetic file.
4. `bash("node evil.js")` cannot launch Node on the host.
5. Unsupported commands cannot fall through to `child_process`.
6. Synthetic temp/spill files never use host temp paths.
7. `../../...` cannot escape the synthetic namespace.
8. Agent cleanup cannot remove host files.
9. Session persistence is explicitly separate from workspace state.
10. A fork cannot mutate its parent world.

A strong implementation rule for `MemoryExecutionEnv` is that its production module should import no `node:fs`, `node:child_process`, `node:http`, `node:https`, or socket APIs.

---

## 20. Acceptance criteria for MVP

The MVP is successful when all of the following are true:

- A real Pi agent can complete a small code-editing task using only the synthetic environment.
- `read`, `write`, `edit`, and `bash` are the normal model-visible tools.
- Project files are never read from or written to disk during the agent run.
- No shell child process is created.
- `bash` and direct file tools share one coherent virtual filesystem.
- `git diff` reports edits against the seed tree.
- The run can be driven interactively or headlessly without changing environment semantics.
- Completion exports a materializable artifact/diff.
- Unsupported physical operations fail explicitly.
- Tests prove host-path escape is impossible through the synthetic tools.

---

## 21. Evaluation experiment

Pick 10–20 ordinary repository tasks that mainly involve source inspection/editing.

Run each task in two modes:

```text
A. Pi + NodeExecutionEnv
B. Pi + MemoryExecutionEnv
```

Measure:

```text
task success before validation
number of tool calls
number of unsupported shell calls
time spent in environment operations
time to first edit
LLM tokens
artifact correctness after materialization
real-validator correction cycles
```

The first important question is:

> What fraction of useful coding-agent work can happen without a physical execution environment at all?

Do not optimize synthetic command coverage until the traces show which missing commands actually block agents.

---

## 22. Implementation sequence

### M0 — source-grounded spike

- fork Pi;
- add empty `MemoryExecutionEnv` implementing the interface;
- wire it into `experimental/mini/worker/run.ts` behind an option;
- keep session storage on Node/disk;
- prove a prompt reaches the harness.

### M1 — MemoryFS

- directories/files/bytes;
- path normalization;
- text/binary reads;
- writes/appends/rename/remove;
- metadata/listing;
- temp files;
- line reader;
- unit tests for the entire Pi `FileSystem` contract.

### M2 — MemoryShell

- parser for sequencing/pipes/redirection;
- command registry;
- output capture/exit codes;
- abort/timeout handling;
- no host process escape.

### M3 — Git facade + artifacts

- status/diff/ls-files;
- baseline snapshot;
- artifact export;
- materializer utility for tests only.

### M4 — interactive + unattended parity

- drive same session from interactive client;
- headless/RPC runner;
- detach/reattach does not alter workspace state.

### M5 — benchmark

- run real coding tasks;
- log unsupported commands;
- decide which commands/services deserve synthetic implementations next.

---

## 23. Suggested initial file layout

```text
packages/agent/src/harness/env/
├── nodejs.ts                 # existing
├── memory.ts                 # ExecutionEnv composition
├── memory-fs.ts              # VFS
├── memory-shell.ts           # parser + execution
├── memory-commands.ts        # command registry
├── memory-git.ts             # status/diff facade
└── memory-artifact.ts        # snapshot/diff/export

packages/agent/test/harness/env/
├── memory-fs.test.ts
├── memory-shell.test.ts
├── memory-git.test.ts
└── memory-isolation.test.ts
```

If this proves useful, promote `MemoryExecutionEnv` into its own package later rather than coupling the concept permanently to Pi.

---

## 24. Minimal implementation sketch

```ts
export class MemoryExecutionEnv implements ExecutionEnv {
  cwd = "/workspace"

  constructor(
    private readonly fs: MemoryFs,
    private readonly shell: MemoryShell,
  ) {}

  // FileSystem methods delegate to MemoryFs.
  // Shell.exec delegates to MemoryShell.
  // No host fs/process/network API is reachable here.

  snapshot(): MemorySnapshot {
    return this.fs.snapshot()
  }

  fork(): MemoryExecutionEnv {
    const fs = this.fs.fork()
    return new MemoryExecutionEnv(fs, new MemoryShell(fs))
  }

  exportArtifact(): WorkspaceArtifact {
    return artifactFromDiff(this.fs.baseSnapshot(), this.fs.snapshot())
  }
}
```

The key is not the class itself. The key is preserving Pi's existing environment contract so the agent and built-in tools remain oblivious.

---

## 24.1 Prototype delivered with this spec

A source-grounded prototype bundle accompanies this spec in `pi-synthetic-git-prototype/`. It contains:

```text
packages/agent/src/harness/env/memory-source.ts
packages/agent/src/harness/env/github-snapshot-source.ts
packages/agent/src/harness/env/memory-git.ts
packages/agent/src/harness/env/memory.ts
packages/agent/test/harness/env/memory-git.test.ts
apply.sh
```

The prototype also includes a replacement for Pi’s experimental mini worker that keeps `JsonlSessionRepo` on `NodeExecutionEnv` while routing the agent-visible `read/write/edit/bash` tools into `MemoryExecutionEnv`. Current Pi inference is left untouched, so `opencode-go` or any other configured Pi provider can be used normally.

The bundle is intentionally an experimental patch, not yet an upstream-quality implementation. The first validation step is to apply it to a Pi checkout and run the package build/test suite, then tighten any interface differences exposed by the current monorepo.

## 25. Decision

**Start with Pi's `packages/agent` harness, not by rewriting the full coding-agent.**

The upstream code already provides the execution abstraction we would otherwise have needed to design. The first prototype should therefore be primarily a new `ExecutionEnv` implementation plus a small worker wiring change.

Once the synthetic machine is proven, integrate it into the normal coding-agent/TUI through operation adapters or a first-class `--execution-env=memory` mode.

That keeps the experiment focused on the novel question: **can a real coding agent operate productively inside a deterministic in-memory machine?**
