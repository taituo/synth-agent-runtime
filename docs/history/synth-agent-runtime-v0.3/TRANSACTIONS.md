# Transactional turns

`MemoryWorkspace.restore()` plus `WorkspaceTransaction` makes synthetic tool effects reversible inside a turn.

`runTransactionalTurn()` runs ordered attempts. If an attempt fails and the caller says it is retryable, the workspace returns to the exact pre-attempt RAM overlay before the next attempt runs.

This is safe for synthetic filesystem mutations. It does not magically reverse arbitrary external effects. Network sends, deploys or physical commands need idempotency/compensation or must be excluded from automatic replay.
