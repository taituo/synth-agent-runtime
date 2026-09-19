# Hardening status

## Current security/correctness model

Durable agent state is hard-fenced by lease generation, and the fence check is atomic with the agent write in PostgreSQL: an unfenced write cannot update an agent row once its `fencing_token` is nonzero. `LeasedAgentRunner` passes the active lease generation into `AgentRuntime.run()`, every durable agent-state transition is persisted through `DurabilityProvider.putAgentFenced()`, and PostgreSQL validates owner, token, and lease expiry against `synth_leases` before committing. A stale writer fails with `AGENT_FENCE_REJECTED` instead of publishing a false terminal state.

PostgreSQL lease decisions use `clock_timestamp()` rather than worker-provided timestamps, so clock skew between workers cannot be used to steal or extend a lease. `CommandCoordinator` validates its lease the same way before terminal commit.

Agent identity creation (`DurabilityProvider.createAgent()`) and mailbox delivery (`MailboxStore.appendMailbox()` returning `{ envelope, inserted }`) are both atomic at the insertion boundary, closing the duplicate-spawn and cross-replica double-steer races found during audit (see `docs/DISTRIBUTED.md` and `CHANGELOG.md`). This is a hardened reference implementation, not a security certification.

## Existing protections

The package includes transactional workspace rollback, semantic-exposure barriers, durable command/effect receipts, SIGKILL recovery, command fencing generations, project CAS, tenant-scoped continuation/affinity, gVisor-oriented Kubernetes manifests, restricted Pod security settings, warm-pool reset verification, request-size limits, abort propagation (a disconnecting client cannot crash the gateway process), git ref/remote input validation for the workspace source, and explicit live-test SKIP reporting when infrastructure/credentials are unavailable.

## Fail closed

The runtime intentionally chooses an uncertain/reconciliation-required state rather than guessing after a crash near an external effect. A passing test suite is not used as evidence that an untested external effect can safely be replayed.

## Multi-tenant caveats

`StaticBearerAuthenticator` stores clear bearer tokens in process memory and compares them with plain string equality rather than a constant-time comparison. `InMemoryTenantRateLimitPolicy` is per-process, so a tenant's effective rate limit scales with replica count in a horizontally-scaled gateway deployment. Production deployments need a real identity source, secret handling, distributed quotas/rate limits, an audit sink, and tenant-aware data-retention rules. See `CHANGELOG.md`'s "Known issues carried into this RC" section for the exact current list.

## Distributed and operational caveats still open

Hard persistence-level fencing for agent-state mutations is closed (see above). The correctness/security gaps closed across this RC's audit passes are tracked in `docs/CODE-REVIEW.md` and `docs/SECOND-REVIEW.md`; what remains before a GA `1.0.0` tag is operational hardening rather than a correctness gap: sustained multi-replica soak/load testing, rolling schema/application upgrade testing, distributed rate limiting, per-record task/artifact revision/CAS, and continuation size/encryption/retention policy. See `docs/RELEASE-GATE.md` for the authoritative current checklist.
