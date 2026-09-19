# Upgrade: v0.7 → v0.8

v0.8 preserves the main v0.7 runtime APIs but adds distributed-state semantics.

## Database

Apply the new schema after the v0.5/v0.7 baseline:

```bash
psql "$SYNTH_POSTGRES_URL" -f deploy/postgres/002_distributed_control_plane.sql
```

`installPostgresSchema()` also includes the v0.8 tables.

## World

`ProjectSpec` now has `revision`. Legacy serialized projects missing it are read as revision `0`. New concurrent mutations should use `compareAndSwapProject()`.

## Commands

`AgentRuntime.command()` remains for local/simple use. Multi-replica commands should move to `CommandCoordinator` + a shared `LeaseStore` so abandoned `started` records can be reconciled and fenced.

## Mailbox

Pass a `MailboxStore` as the fifth `AgentRuntime` constructor argument to enable durable sequence/cursor behavior. Without it, snapshot-mailbox behavior remains compatible with older releases.

## Inference

Pass a shared `RouterStateStore` to `ProfileRouterBackend` and a shared `ContinuationStore` to the OpenCode Responses adapter when running multiple gateway replicas.

## Gateway security

Authentication/policy is opt-in. Existing deployments remain open unless `authenticator`/`tenantPolicy` are supplied to the HTTP gateway.

## History

The original v0.7 root documentation is preserved under `docs/history/synth-agent-runtime-v0.7/`.
