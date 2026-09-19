# Kubernetes execution design

A Pod is a temporary execution lease, not a logical agent.

```text
Durable logical agent
       │
 synthetic RAM first
       │ unsupported/physical effect
       ▼
 ExecutionBroker
       ▼
 bounded gVisor Pod / ProjectCell
```

## Isolation baseline

Generated executor Pods use gVisor through `RuntimeClass`, no mounted ServiceAccount token, non-root execution, no privilege escalation, dropped capabilities, `RuntimeDefault` seccomp, read-only root filesystem, no hostPath/Docker socket, and bounded writable `/workspace` + `/tmp` volumes.

## Warm-pool reset

Before reuse, `/workspace` and `/tmp` are cleared and `verifyReset()` must pass when implemented. Failed proof destroys the Pod rather than returning it to the ready pool.

## v0.6 live Pod-kill contract

`integrations/kubernetes/kill-chaos.ts` creates a real sandbox, starts a long-running exec, then force-deletes the Pod with `kubectl`. Successful contract execution requires the in-flight command not to report success.

The artifact build environment has no `kubectl`/cluster, so this script is bundled but not marked as executed. See `LIVE-CONTRACTS.md`.
