# Chaos and failure testing

The runtime needs deterministic failure injection because random chaos is useful operationally but poor as a regression test.

## Failpoints

`ChaosController` takes rules:

```ts
new ChaosController([
  { point: "state.putTurn.after", nth: 1 },
  { point: "executor.execute.after", nth: 2 },
]);
```

A rule fires exactly once by default. `repeat: true` fires on every matching hit from `nth` onward.

Wrappers currently cover:

- `DurabilityProvider`;
- `RuntimeStateStore`;
- `Executor`;
- `GatewayBackend`.

## Important scenarios

### Interrupted turn

A turn is persisted as `started`, the RAM workspace changes, and the control plane disappears. On recovery, the runtime scans `started` turns and restores the serialized pre-turn snapshot before marking the turn rolled back.

### External effect ambiguity

If an executor returns or performs an external action and the process fails before the broker can persist `committed`, the effect must not be blindly replayed. v0.5 keeps the receipt in `started` state on executor exceptions, so later calls return `EFFECT_OUTCOME_UNCERTAIN:<id>`.

### Provider/account failure

`ProfileRouterBackend` already supports health/cooldown and session affinity. Chaos wrapping allows deterministic pre-response failures. Mid-stream replay still belongs inside the durable semantic transaction and is not performed by the network router after a successful streaming response has escaped.

## Focused matrix

```bash
npm run build
node scripts/chaos-matrix.mjs
```

The matrix runs chaos, durable transaction, Kubernetes reset and Postgres claim suites as separate Node test processes.
