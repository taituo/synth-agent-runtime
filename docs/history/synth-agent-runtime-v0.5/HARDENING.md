# Hardening status

v0.4 is a stronger prototype, not a claim of production security certification.

## Implemented failure boundaries

- runtime workspace checkpoints;
- interrupted-turn rollback;
- buffered semantic output before commit;
- effect idempotency receipts and uncertain-outcome detection;
- provider/account session affinity and cooldowns;
- persistent native Git blob reader;
- per-blob hydration limit;
- gVisor-oriented resource classes;
- non-root Pods, dropped capabilities, read-only root filesystem and no ServiceAccount token;
- explicit NetworkPolicy generation;
- warm-pool reset verification with destroy-on-failure.

## Still required for production

- database-backed `RuntimeStateStore` and `WorldStore` with multi-writer transactions;
- actual chaos tests that kill the control-plane process, Temporal workers and Kubernetes Pods;
- scoped secret broker and workload identity;
- image digest enforcement/signature verification;
- dedicated sandbox nodes/taints and cluster policy enforcement;
- egress proxy policy by destination/domain/identity;
- LFS/submodule policy and shared Git object-cache quotas;
- compensation/reconciliation workflows for external effects with uncertain outcomes;
- admission-policy tests proving no hostPath, privileged container, socket mount or ServiceAccount credential reaches untrusted executors;
- load tests for hundreds/thousands of logical agents.

The design intentionally fails closed on uncertain external effects and failed sandbox reset verification.


## v0.5 concurrency hardening

Multi-process stores should implement atomic `claimCommand()` and `claimEffect()`. The Postgres adapter does. Effects are never automatically reclaimed once an ID exists; `started` means the external outcome may be unknown and must be reconciled rather than blindly repeated.

Executor exceptions now preserve that uncertain state. This closes the failure window where an external action could succeed and the process could fail before a committed receipt was stored.
