# Hardening status

v0.8 is a hardened prototype/reference implementation, not a security certification.

## Existing protections

The package includes transactional workspace rollback, semantic-exposure barriers, durable command/effect receipts, SIGKILL recovery, command fencing generations, project CAS, tenant-scoped continuation/affinity, gVisor-oriented Kubernetes manifests, restricted Pod security settings, warm-pool reset verification, request-size limits, abort propagation, and explicit live-test SKIP reporting.

## Fail closed

The runtime intentionally chooses an uncertain/reconciliation-required state rather than guessing after a crash near an external effect. A passing test suite is not used as evidence that an untested external effect can safely be replayed.

## Multi-tenant caveats

`StaticBearerAuthenticator` stores clear bearer tokens in process memory and `InMemoryTenantRateLimitPolicy` is per-process. Production deployments need a real identity source, secret handling, distributed quotas/rate limits, an audit sink, and tenant-aware data-retention rules.

## Distributed caveats

The largest remaining correctness item is hard persistence-level fencing for all stale agent mutations, not only command records. See `CODE-REVIEW.md` for prioritized findings.
