# Recovery model

Logical state must survive loss of a control-plane process. A fresh `AgentRuntime` reconstructs agents from `DurabilityProvider`, workspaces from durable checkpoints, and interrupted turns from `RuntimeStateStore`.

## Interrupted turn rule

Any durable turn still in `started` state after restart is considered interrupted. Recovery restores its serialized pre-turn workspace snapshot and records the turn as `rolled_back` before the agent is made available again.

## Agent state normalization

Arbitrary JS stacks are never resumed. Non-terminal states such as `thinking` are normalized to `idle` (or the configured recovery state) and annotated with `recoveredFromState`/`recoveredAt` metadata.

## v0.6 evidence

The root suite now performs this through a separate process and real `SIGKILL`, using `JsonFileDurabilityProvider` plus `JsonFileRuntimeStateStore`. This proves the recovery path does not depend on surviving in-memory objects from the failed process.

For multiple simultaneous control-plane processes, use `PostgresPersistence`; the JSON files are single-writer reference backends.
