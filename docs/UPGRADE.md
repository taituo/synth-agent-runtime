# Upgrade: v0.8 → v0.9

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

Run distributed agents through `LeasedAgentRunner`; it passes the active lease resource, owner, and fencing token to `AgentRuntime.run()`. If you call `AgentRuntime.run()` directly against a PostgreSQL agent that has already entered fenced ownership, later unfenced state writes will be rejected.

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
npm run distributed:contract
npm run release-hardening:contract
npm run process-crash:contract
npm run responses:contract
npm run integrations:syntax
npm run live:proof
```

The v0.8 root Markdown set is preserved under `docs/history/synth-agent-runtime-v0.8/`.
