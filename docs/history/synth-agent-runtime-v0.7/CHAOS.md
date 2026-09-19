# Chaos and failure testing

v0.7 combines deterministic failpoints with real process-death contracts and opt-in live external failure tests.

## Deterministic failpoints

`ChaosController` can fail exact numbered boundaries such as:

```text
state.putTurn.after
executor.execute.before
executor.execute.after
durability.putAgent.after
gateway.handle.before
gateway.handle.after
```

This makes failure windows reproducible rather than probabilistic.

## Real process death

`test/process-crash.test.ts` launches a child process and sends real `SIGKILL` during a durable turn. Recovery occurs in a fresh process from persisted files.

## Live external chaos

When configured, `npm run live:proof` can add:

- PostgreSQL multi-connection claim contention;
- Pi E2E against a real checkout;
- Kubernetes executor Pod force-delete;
- a live gateway Responses probe.

Temporal worker/server kill testing remains review-driven future work.

The contract is fail-closed: a failure may recover automatically or enter an explicit reconciliation state, but it must not silently duplicate an external effect or report an ambiguous sandbox operation as success.
