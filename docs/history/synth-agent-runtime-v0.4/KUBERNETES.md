# Kubernetes execution design

A Pod is a temporary execution lease, not a logical agent.

```text
many durable logical agents
        │
        ├ synthetic RAM work
        │
        └ selected physical effects
                 │
                 ▼
            bounded pool
             gVisor Pods
```

## Resource classes

Built-in profiles live in `src/execution/resource-class.ts`:

- `sandbox-small`
- `sandbox-medium`
- `sandbox-heavy`
- `project-cell`

Each controls runtime class, requests/limits, writable storage, deadline, network policy and warm-pool policy.

## Isolation baseline

Generated executor Pods use the current prototype baseline:

```text
runtimeClassName: gvisor
automountServiceAccountToken: false
runAsNonRoot: true
allowPrivilegeEscalation: false
privileged: false
capabilities.drop: [ALL]
seccompProfile: RuntimeDefault
readOnlyRootFilesystem: true
no hostPath / no Docker socket
```

Only `/workspace` and `/tmp` are writable `emptyDir` volumes.

## Network

Normal sandboxes get DNS plus explicit egress-proxy reachability. ProjectCells get cell-local service connectivity plus DNS. The generated policy intentionally does not add an unrestricted `0.0.0.0/0` egress rule.

## Warm-pool reuse

Release now follows:

1. clear `/workspace` and `/tmp`;
2. run `verifyReset()` when implemented;
3. return the Pod only if verification succeeds;
4. otherwise destroy it;
5. reap idle/excess ready Pods.

`KubectlSandboxBackend.verifyReset()` checks that no entries remain in `/workspace` or `/tmp`.

This is still only one proof dimension. Production should also verify process cleanup, mount state, service state and any executor-specific caches—or destroy rather than reuse high-risk cells.

## Workspace materialization

Private repository credentials stay in the trusted control plane. `NativeGitSource` reads the pinned Git base and `WorkspaceSynchronizer` transfers visible file bytes into the Pod. The RAM overlay is applied after the baseline, and source changes are synchronized back after execution.

## Production hardening still required

- digest-pinned/signed executor images;
- ResourceQuota/LimitRange;
- dedicated sandbox node pools and taints;
- admission-policy tests;
- scoped workload identity/secret broker;
- destination-aware egress proxy policy;
- reset chaos tests and destructive fallback for unprovable cleanup.
