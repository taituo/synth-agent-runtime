# Pi synthetic Git workspace prototype

Targeted at `earendil-works/pi` main commit `36b60d2e8985899743c4cf5bd5f8929832a3f05d`.

This prototype makes Pi's normal harness tools run against a **fully in-memory project workspace** while keeping inference and session persistence real.

## What it adds

```text
Pi AgentHarness
    |
    +-- read/write/edit/bash (unchanged)
    |       |
    |       v
    |   MemoryExecutionEnv
    |       |
    |       +-- immutable lazy Git source
    |       +-- in-memory overlay
    |       +-- synthetic shell
    |       +-- synthetic git
    |
    +-- Models / inference (unchanged)
            |
            +-- opencode-go
            +-- OpenAI / Anthropic / etc.
```

The Git source included here is `GitHubSnapshotSource`. It resolves a commit once and then uses GitHub's API as a **demand-paged immutable base tree**:

- no checkout directory;
- no `.git` directory;
- no project files written to disk;
- one commit snapshot only (shallow by construction);
- optional sparse path prefixes;
- file blobs fetched only when read;
- edits/deletes/new files live only in RAM.

The synthetic `git` command derives its state from the immutable source plus the in-memory overlay. Initial commands are:

```text
git status
git status --short
git diff
git diff --stat
git diff -- <path>
git rev-parse HEAD
git branch --show-current
git show HEAD:<path>
git ls-files
```

The synthetic shell currently includes the high-value inspection/edit support needed by coding agents: `pwd`, `cd`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `find`, `echo`, `printf`, `mkdir`, `rm`, `cp`, `mv`, `touch`, `sort`, `uniq`, sequencing, simple pipelines, and redirection. Unsupported programs return exit 127 and **never fall through to the host**.

## Apply to a Pi checkout

```bash
./apply.sh /path/to/pi
```

This copies the new harness files, adds the package export `@earendil-works/pi-agent-core/harness/env/memory`, adds tests, and replaces the experimental mini worker with a synthetic-aware version. A backup of the original worker is created beside it.

Then configure a source:

```bash
export PI_SYNTH_GITHUB_REPO=owner/repo
export PI_SYNTH_GITHUB_REF=main
export PI_SYNTH_GITHUB_SPARSE=src,packages/foo,package.json
# optional for private repos / higher API limits
export GITHUB_TOKEN=...
```

`PI_SYNTH_GITHUB_SPARSE` is optional. When present, only those prefixes and their ancestors are visible to the synthetic workspace. Directory metadata and blobs are still hydrated lazily.

## OpenCode Go / subscription inference

Nothing special is needed in the synthetic environment. Current Pi already has an `opencode-go` provider, so the same harness can use OpenCode Go inference while the workspace stays synthetic.

```bash
export OPENCODE_API_KEY=...
```

Select `opencode-go` / the desired model through Pi's normal model configuration. The environment and inference layers are independent.

## Dynamic model

The important abstraction is not GitHub specifically. `MemoryExecutionEnv` mounts any `VirtualTreeSource`:

```ts
interface VirtualTreeSource {
  revision(): Promise<WorkspaceRevision | undefined>
  stat(path: string): Promise<VirtualSourceInfo | undefined>
  listDir(path: string): Promise<readonly VirtualSourceInfo[]>
  readFile(path: string): Promise<Uint8Array>
  listFiles?(): AsyncIterable<string>
}
```

That means the immutable base can later be:

- generic Git smart-HTTP / `isomorphic-git`;
- GitLab / Bitbucket API;
- an object-store snapshot;
- a database-backed tree;
- another agent's snapshot;
- a synthetic generated repository.

The mutable overlay and Pi tool behavior stay the same.

## Workspace artifact

`MemoryExecutionEnv.exportArtifact()` returns only the changed paths relative to the immutable source, plus the source revision. That is the handoff point to a real validator:

```text
in-memory agent
   -> changed-file artifact
   -> real K8s/gVisor/Firecracker sandbox
   -> test/build
```

## Status

This is a **source-grounded prototype**, not a finished upstream patch. It was written against the current Pi interfaces and the relevant current source, but this environment cannot install the Pi monorepo dependencies or run the full upstream test suite. Run Pi's normal build/tests after applying it and expect a small amount of integration cleanup as upstream evolves.
