# Hardening status

## Current security/correctness model

Durable execution is Temporal's job: `durableAgentWorkflow` owns the agent
lifecycle and mailbox, and every turn runs through the shared
`GatewayAgentEngine`. Agent-state writes are hard-fenced at the store boundary:
`DurabilityProvider.putAgentFenced()` persists a state transition only when the
matching `synth_leases` row still has the same owner, fencing token and DB-time
expiry, and `synth_agents.fencing_token` prevents generation regression. A stale
writer fails with `AGENT_FENCE_REJECTED` instead of publishing a false terminal
state. PostgreSQL lease decisions use `clock_timestamp()`, so worker clock skew
cannot steal or extend a lease.

Effect execution is receipt-backed: `ExecutionBroker` claims an effect by id, a
committed receipt is replayed, and a receipt left `started` by a crash is
returned as `EFFECT_OUTCOME_UNCERTAIN` — never a blind replay. Agent identity
creation (`DurabilityProvider.createAgent()`) and mailbox delivery
(`MailboxStore.appendMailbox()` returning `{ envelope, inserted }`) are atomic at
the insertion boundary, closing the duplicate-spawn and cross-replica
double-steer races. This is a hardened reference implementation, not a security
certification.

## Existing protections

The package includes workspace snapshot/rollback, effect receipts, worker-death
recovery (Temporal retries the in-flight activity and replays committed history;
live-proven by the durable/graph restart proofs), project CAS, tenant-scoped
continuation/affinity, gVisor-oriented Kubernetes manifests, restricted Pod
security settings, warm-pool reset verification, request-size limits, abort
propagation (a disconnecting client cannot crash the gateway process), git
ref/remote input validation for the workspace source, and explicit live-test
SKIP reporting when infrastructure/credentials are unavailable.

## Fail closed

The runtime intentionally chooses an uncertain/reconciliation-required state
rather than guessing after a crash near an external effect. A passing test suite
is not used as evidence that an untested external effect can safely be replayed.

## Multi-tenant caveats

`StaticBearerAuthenticator` stores clear bearer tokens in process memory and
compares them with plain string equality rather than a constant-time comparison.
`InMemoryTenantRateLimitPolicy` is per-process, so a tenant's effective rate
limit scales with replica count in a horizontally-scaled gateway deployment.
Production deployments need a real identity source, secret handling, distributed
quotas/rate limits, an audit sink, and tenant-aware data-retention rules. See
`CHANGELOG.md`'s "Known issues carried into this RC" section for the exact
current list.

## Distributed and operational caveats still open

Hard persistence-level fencing for agent-state mutations is closed (see above).
What remains before a GA `1.0.0` tag is operational hardening rather than a
correctness gap: sustained multi-replica soak/load testing, rolling
schema/application upgrade testing, distributed rate limiting, per-record
task/artifact revision/CAS, and continuation size/encryption/retention policy.
See `docs/RELEASE-GATE.md` for the authoritative current checklist and
`docs/KNOWN-OPEN.md` for the itemised open work.
