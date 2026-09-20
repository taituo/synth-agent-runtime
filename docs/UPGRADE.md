# Upgrade: v0.8 → v0.9

> **Runtime consolidation (2026-09-20).** Temporal is the single durable engine
> and the shared `GatewayAgentEngine` is the one turn body. The homegrown
> `AgentRuntime`, `DurableTurn`/`transactional-turn`, `TemporalDurabilityProvider`,
> `EffectReconciler`, `AgentRunner`/`LeasedAgentRunner`, `CommandCoordinator`,
> `EffectPolicy` and orchestration `Supervisor` were deleted (`CHANGELOG.md`,
> Unreleased). References below to those APIs are historical. The Postgres stores
> (leases/fencing, effect receipts, mailbox cursors, world revisions) remain; see
> the root `README.md` and `docs/KNOWN-OPEN.md` for the current shape.

v0.9 keeps the v0.8 distributed-control-plane APIs but tightens ownership semantics. The important change is that a leased agent run now carries a fencing proof all the way to the persistence write.

## Database

Apply the existing v0.8 distributed schema and then the v0.9 hardening migration:

```bash
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/002_distributed_control_plane.sql
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/003_release_hardening.sql
```

`installPostgresSchema()` also upgrades `synth_agents` with `fencing_token` when used directly.

## Application rollout

Deploy all control-plane replicas with v0.9 before treating hard fencing as a production invariant. A mixed fleet with older writers is not considered hard-fenced.

Agent-state writes carry a fencing generation. `DurabilityProvider.putAgentFenced()` validates the owner, the fencing token and the lease's PostgreSQL-clock expiry atomically against `synth_leases`, so a stale writer is rejected with `AGENT_FENCE_REJECTED`. The `LeasedAgentRunner`/`AgentRuntime` helpers that used to pass the lease generation are gone with the deleted runtime; the store-level fence remains and is covered by `test/postgres-control.test.ts` and the live 32-worker proof.

## Custom implementations

Custom `LeaseStore` implementations must add:

```ts
validateLease(resourceId, ownerId, fencingToken, now?): Promise<LeaseRecord | undefined>
```

Distributed `DurabilityProvider` implementations used with leased agents should implement:

```ts
putAgentFenced(snapshot, fence): Promise<boolean>
```

The validation and state mutation must be atomic at the authoritative datastore boundary.

## Recovery

If recovery needs to mutate an already-fenced agent in a distributed store, supply `AgentRecoveryOptions.fence`. Single-writer local/JSON deployments can continue using unfenced recovery.

## Verification

```bash
npm test
npm test --prefix integrations/temporal
npm run responses:contract
npm run integrations:syntax
npm run live:proof
```

The v0.8 root Markdown set is preserved under `docs/history/synth-agent-runtime-v0.8/`.
