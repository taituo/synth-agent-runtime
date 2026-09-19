# Kubernetes / gVisor execution

Logical agents do not own permanent Pods. `ExecutionBroker` leases a physical sandbox only when a command needs more fidelity than the synthetic environment.

## Isolation defaults

Generated executor Pods are designed around:

- configured sandbox `RuntimeClass` (normally gVisor);
- non-root user;
- `allowPrivilegeEscalation: false`;
- capabilities dropped;
- `RuntimeDefault` seccomp;
- no ServiceAccount token mount;
- no hostPath or Docker socket in the generated executor manifest;
- bounded CPU/memory/ephemeral storage;
- explicit NetworkPolicy generation.

## Warm pool lifecycle

```text
acquire
  -> ready slot or create reserved slot
  -> lease
  -> execute
  -> reset /workspace + /tmp
  -> verifyReset()
      PASS -> ready / serve waiter
      FAIL -> destroy
```

v0.7 fixes a concurrency race where a slot created for one direct acquire could be handed to a waiter before the original caller leased it. Closing the pool now rejects queued callers rather than leaving unresolved promises.

## Workspace sync-back

The physical executor materializes the synthetic workspace, runs the command, computes changes and syncs them back. v0.7 makes this logical commit atomic: a read/size/apply error restores the pre-sync RAM snapshot. A failed sandbox `git status` is an error, not an empty diff.

## Live Pod-kill contract

`integrations/kubernetes/kill-chaos.ts` force-deletes an executor Pod while `kubectl exec` is active and requires the operation not to report success. `.github/workflows/kubernetes-live.yml` is intentionally manual/self-hosted because it requires a runner backed by a real gVisor-configured cluster.

The current artifact environment had no Kubernetes cluster or `kubectl`, so this contract is bundled but reported as skipped here.

## Production gaps

Before direct production use, enforce digest-pinned executor images, validate cluster-specific DNS/egress policy, use scoped secret references/broker, test admission policies, and run repeated reset/pod-kill tests on the actual target cluster. See `CODE-REVIEW.md` CR-R10.


## v0.8 control-plane ownership

Kubernetes executor leases and control-plane agent/command leases are separate. A long-lived logical agent may change control-plane owner and physical sandbox independently. Sandbox reset/isolation rules from v0.7 remain in force.
