# Recovery model

Logical state must survive loss of a control-plane process. A fresh `AgentRuntime` reconstructs agents from `DurabilityProvider`, workspaces from durable checkpoints, and interrupted turns from `RuntimeStateStore`.

## Interrupted turn rule

A durable turn still in `started` state after restart is interrupted. Recovery restores its serialized pre-turn workspace snapshot before making the agent available again.

The terminal recovery status depends on the durable semantic boundary:

```text
started + semanticExposed=false
  -> workspace restore
  -> rolled_back
  -> safe to start a fresh attempt

started + semanticExposed=true
  -> workspace restore
  -> failed
  -> reconciliation required
  -> no transparent replay claim
```

This prevents a crash after a possibly irreversible effect from being misrepresented as a clean retryable rollback.

## Agent state normalization

Arbitrary JavaScript call stacks are never resumed. Non-terminal states such as `thinking` are normalized to `idle` (or the configured recovery state) and annotated with `recoveredFromState` / `recoveredAt` metadata.

## Evidence in v0.7

The root suite launches a separate Node process, persists an active durable turn, mutates the workspace, then kills the child with real `SIGKILL`. A new process opens `JsonFileDurabilityProvider` + `JsonFileRuntimeStateStore` and verifies restoration.

A second regression test covers the exposed-turn branch and requires reconciliation rather than transparent rollback.

For multiple simultaneous control-plane processes use `PostgresPersistence`; JSON file stores remain single-writer reference/development backends.

## Still not exact mid-stream resume

Actual buffered semantic text/tool frames are process-local today; the durable record stores boundary metadata and counts. Therefore recovery restarts from the durable turn boundary rather than resuming the exact token/tool frame where the process died. See `CODE-REVIEW.md` CR-R08.
