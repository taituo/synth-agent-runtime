# Durable project world

The project world is the canonical specification/task/artifact context; chat transcript is not the source of truth.

## Project revision

v0.8 adds `ProjectSpec.revision` and `WorldStore.compareAndSwapProject()`.

```ts
const current = await world.getProject(projectId)
const next = structuredClone(current)
next.objective = "new objective"
const result = await world.compareAndSwapProject(next, current.revision)
if (!result.swapped) {
  // result.project is the newer canonical value; merge/retry deliberately.
}
```

CAS semantics are implemented by `InMemoryWorldStore`, `JsonFileWorldStore`, and `PostgresPersistence`.

## Internal mutations

`attachTask`, `attachArtifact`, and `addDecision` use CAS retry loops in the in-memory model. PostgreSQL consumers should likewise use revision-aware project mutations instead of blind replacement.

## Current granularity

Project membership/decisions are revisioned. Task and artifact bodies are still independent last-write-wins records. Per-task/per-artifact revisions or an append-only world event log are intentionally left for the next hardening phase.
