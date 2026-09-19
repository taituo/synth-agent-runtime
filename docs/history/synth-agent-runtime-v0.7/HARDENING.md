# Hardening status

v0.7 is a hardened prototype/reference implementation, not a production security certification.

## Implemented failure boundaries

- runtime workspace checkpoints and process-restart reconstruction;
- real child-process `SIGKILL` recovery contract;
- durable turn rollback before semantic exposure;
- durable semantic-exposure barrier before irreversible/barrier effects;
- buffered output/tool events before commit;
- effect idempotency receipts and uncertain-outcome fail-closed behavior;
- atomic Postgres command/effect claims for multi-process duplicate prevention;
- provider/account session affinity and cooldowns;
- gateway request-size ceiling, backpressure and cancellation propagation;
- persistent native Git blob reader with blob hydration limit;
- gVisor-oriented resource classes and restricted Pod defaults;
- non-root execution, dropped capabilities, read-only executor root filesystem and disabled ServiceAccount-token mount;
- explicit NetworkPolicy generation;
- warm-pool reset verification with destroy-on-failure;
- warm-pool concurrency fixes preventing double lease;
- atomic physical workspace sync-back on failure;
- deterministic chaos failpoints plus real process-kill contract.

## Important v0.7 rule

A durable `started` turn is only transparently rolled back after restart if it had **not** crossed a persisted semantic-exposure boundary. An exposed interrupted turn becomes `failed` / reconciliation-required. This is intentionally stricter than retrying and risking a duplicate external effect.

## Still required for production

The highest-priority remaining work is listed in `CODE-REVIEW.md`:

- command lease/heartbeat/reconciliation semantics;
- concurrent canonical-world mutation via CAS/operations rather than whole-document last-writer-wins updates;
- shared Responses continuation and router affinity/health state;
- durable mailbox/event cursors and retention;
- generic external-effect reconciliation adapters;
- gateway tenant auth/ACL/rate limits;
- scoped secret broker/workload identity;
- mandatory digest-pinned executor images and cluster admission-policy verification;
- shared Git object cache, LFS/submodule policy and cache quotas;
- real repeated Temporal/Postgres/Pi/gVisor failure CI;
- reproducible dependency lockfile/SBOM for distributable builds.

The design continues to fail closed on uncertain external effects and failed sandbox reset verification.
