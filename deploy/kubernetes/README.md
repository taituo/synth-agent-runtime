# Kubernetes / gVisor execution

This directory contains the cluster-side pieces for physical agent execution.

## 0. The Temporal worker is the runtime

`worker-deployment.yaml` is the only runtime workload. It runs
`integrations/temporal`'s worker: the durable workflow plus the `runTurn`
activity (the shared `GatewayAgentEngine`). It talks to a Temporal frontend and
an OpenAI-compatible gateway; `SYNTH_POSTGRES_URL` is consumed by the
Postgres-backed stores. Model-authored code never runs in this Pod — the
execution rung escalates `process.exec` to an executor Pod behind the `gvisor`
RuntimeClass (below).

**Honest status: not applied by CI.** There is no cluster in the per-push
workflows, so this manifest is a documented deploy shape, not an enforced one.
The gVisor and Temporal live proofs remain manual / self-hosted. Build the worker
image from `integrations/temporal` (which depends on the root `src/`), for
example:

```bash
# from the repository root
docker build -f deploy/worker-image/Dockerfile -t registry.example/synth-temporal-worker:0.4.0 .
kubectl apply -f deploy/kubernetes/worker-deployment.yaml
```

There is deliberately no homegrown control-plane Deployment: the worker above
replaces it, and the Postgres stores it uses are the only durability it owns.

## 1. Install/configure gVisor

The runtime expects a Kubernetes `RuntimeClass` named `gvisor` backed by `runsc`.
Apply `runtimeclass-gvisor.yaml` only after the cluster runtime has been configured
for the `runsc` handler.

```bash
kubectl apply -f deploy/kubernetes/runtimeclass-gvisor.yaml
kubectl get runtimeclass gvisor
```

## 2. Build the executor image

```bash
docker build -t registry.example/synth-executor:0.4.0 deploy/executor-image
docker push registry.example/synth-executor:0.4.0
```

Pin the production image by digest and replace the placeholder image in the
resource classes (or construct your own classes in code).

The executor image needs: `sh`, `git`, `base64`, `find`, and whatever build tools
your project tasks require. It deliberately contains no Kubernetes credentials.

## 3. Control plane identity

The trusted runtime/control-plane process owns the Kubernetes credentials and
invokes `KubectlSandboxBackend`. Agent Pods use:

- `automountServiceAccountToken: false`
- non-root UID/GID
- `allowPrivilegeEscalation: false`
- read-only root filesystem
- all Linux capabilities dropped
- `RuntimeDefault` seccomp
- gVisor `RuntimeClass`
- isolated `/workspace` and `/tmp` `emptyDir` volumes
- default-deny-style per-sandbox NetworkPolicy

The sandbox never needs Kubernetes API access.

## 4. Egress

The default classes use `network.mode = egress-proxy`. Their generated
NetworkPolicy allows DNS plus TCP to a Pod labelled:

```text
namespace: synth.openai.dev/egress=true
pod:       app.kubernetes.io/name=synth-egress-proxy
```

Deploy your own authenticated/filtering proxy there and set `HTTP_PROXY` /
`HTTPS_PROXY` in the resource class if required. There is intentionally no
`0.0.0.0/0` egress rule.

## 5. Warm pool

`WarmSandboxPool` keeps a bounded number of clean, Ready executor Pods. A lease
is reset before it returns to the pool. Failed reset => Pod is destroyed.

## 6. Workspace transfer

`WorkspaceSynchronizer` runs on the trusted control plane. It reads the sparse
`TreeSource` and streams only visible file bytes into `/workspace`; private Git
credentials never enter the untrusted Pod. It creates a local Git baseline in
the sandbox, overlays RAM changes, runs the command, then syncs changed source
files back into `MemoryWorkspace` with file/byte limits.

This is intentionally simple for v0.2. The next optimization is a framed tar or
content-addressed blob transfer so large sparse workspaces do not require one
`kubectl exec` per file.
