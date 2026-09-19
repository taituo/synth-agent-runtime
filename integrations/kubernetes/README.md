# Live Kubernetes / gVisor kill contract

This optional contract deliberately deletes a real executor Pod while a command is running. It is not part of the normal unit suite because it requires `kubectl`, a cluster with the configured sandbox RuntimeClass (normally gVisor), and a published executor image.

```bash
cd integrations/kubernetes
npm install
cd ../..

export SYNTH_EXECUTOR_IMAGE='registry.example/synth-executor@sha256:...'
export SYNTH_RUNTIME_CLASS='gvisor'
# optional
export SYNTH_KUBECTL_CONTEXT='my-cluster'
export SYNTH_KUBERNETES_NAMESPACE='synth-sandboxes'

integrations/kubernetes/node_modules/.bin/tsx integrations/kubernetes/kill-chaos.ts
```

Success means the in-flight `kubectl exec` does not report success after the Pod is force-deleted. Higher-level recovery then uses durable effect/turn state to decide whether a fresh attempt is safe or reconciliation is required.

Use a disposable namespace/cluster and a digest-pinned executor image for this contract.
