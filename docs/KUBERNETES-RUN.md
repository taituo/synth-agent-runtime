# Kubernetes + gVisor: real run guide (executed 2026-09-19 on k3s v1.33)

This is not a generic sketch. Every command below was executed against a
real single-node k3s cluster to prove the v1.0.0-rc.1 kill contract. Copy
pastes are in execution order. Verified 3/3 green runs + isolation probe.

## 0. What you need

- k3s (or any Kubernetes) with cluster-admin kubectl access. Verified on
  `k3s v1.33.2+k3s1`, single node, containerd v2.0.5-k3s1.
- Node >= 22 for the contract runner (`tsx`).
- The repo at tag `v1.0.0-rc.1` (or later), `integrations/kubernetes` installed.
- sudo on the node (for installing runsc + containerd template).
- Network to pull `docker.io/library/busybox` (stand-in executor image).

## 1. Install gVisor (runsc + sentry sidecar)

The `latest` symlink on Google's bucket is dead — resolve the version via API:

```bash
TAG=$(curl -s https://api.github.com/repos/google/gvisor/releases/latest \
  | grep -m1 '"tag_name"' | cut -d'"' -f4)          # e.g. release-20260914.0
curl -sL -o gvisor.tar.bz2 \
  https://github.com/google/gvisor/releases/download/${TAG}/gvisor-x86_64.tar.bz2
sudo apt-get install -y bzip2                       # tar needs it for .bz2
mkdir gvisor && tar -xjf gvisor.tar.bz2 -C gvisor runsc containerd-shim-runsc-v1 gvisor-bin
sudo install -o root -g root -m 0755 gvisor/runsc gvisor/containerd-shim-runsc-v1 /usr/local/bin/
sudo cp -a gvisor/gvisor-bin /usr/local/bin/
runsc --version   # expect: runsc version release-YYYYMMDD.x
```

Without `gvisor-bin/` the shim fails with
`sidecar "gvisor_sentry" not usable ... --sidecar-usage-policy is set to STRICT`.
That directory is mandatory, not optional.

## 2. Register runsc in k3s containerd (with backup + rollback)

k3s regenerates `config.toml` on restart, so write a **template**, never the
generated file. Back up first:

```bash
sudo cp -a /var/lib/rancher/k3s/agent/etc/containerd /tmp/containerd-backup
sudo cp /var/lib/rancher/k3s/agent/etc/containerd/config.toml \
        /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl
printf '\n[plugins.'"'"'io.containerd.cri.v1.runtime'"'"'.containerd.runtimes.runsc]\n  runtime_type = "io.containerd.runsc.v1"\n' \
  | sudo tee -a /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl
sudo systemctl restart k3s
sleep 10 && kubectl get nodes   # must be Ready
```

Rollback if anything breaks:

```bash
sudo rm /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl
sudo cp /tmp/containerd-backup/config.toml /var/lib/rancher/k3s/agent/etc/containerd/config.toml
sudo systemctl restart k3s
```

## 3. RuntimeClass + isolation proof

```bash
cat | kubectl apply -f - <<'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
EOF
```

Prove the sandbox is real (a raw `kubectl run` is REJECTED here — the
namespace enforces PodSecurity `restricted:latest`, which is the point; use
a manifest with the restricted securityContext, same shape the backend emits):

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: gverify
  namespace: synth-verify
spec:
  restartPolicy: Never
  runtimeClassName: gvisor
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: probe
      image: docker.io/library/busybox:1.36
      command: ["sh", "-lc", "sleep 120"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 65532
        capabilities: { drop: ["ALL"] }
        seccompProfile: { type: RuntimeDefault }
EOF
kubectl exec -n synth-verify gverify -- cat /proc/version
# expect: Linux version 4.19.0-gvisor ...
kubectl exec -n synth-verify gverify -- dmesg | head -2
# expect: [ 0.000000] Starting gVisor...
kubectl delete ns synth-verify --wait=true
```

Note: `kubectl run` has NO `--runtime-class-name` flag in v1.33 — use
`--overrides='{"spec":{"runtimeClassName":"gvisor"}}'` or a manifest.

## 4. Pin the executor image by digest

Tags float; the contract demands a pinned image. Resolve once, export always:

```bash
DIGEST=$(sudo crictl inspecti docker.io/library/busybox:1.36 \
  | grep -m1 -oE 'busybox@sha256:[a-f0-9]{64}')
export SYNTH_EXECUTOR_IMAGE="docker.io/library/${DIGEST}"
# executed value: docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
```

(Production: replace busybox with the real executor image built from
`deploy/executor-image/Dockerfile`, pushed to your registry, same `@sha256:`
form.)

## 5. Run the kill contract (the actual proof)

```bash
cd <repo>
cd integrations/kubernetes && npm install && cd ../..

export SYNTH_RUNTIME_CLASS='gvisor'
export SYNTH_KUBERNETES_NAMESPACE='synth-audit-gvisor'   # disposable
export SYNTH_EXECUTOR_IMAGE   # from step 4

integrations/kubernetes/node_modules/.bin/tsx integrations/kubernetes/kill-chaos.ts
# expect: {"ok":true,...,"exitCode":137}
```

What it proves: an executor Pod is started in a gVisor sandbox, a command
runs inside, the Pod is force-deleted mid-flight, and the in-flight `kubectl
exec` does NOT report success (exit 137). The backend cleans up Pod +
NetworkPolicy in `finally`. Delete the namespace afterwards:
`kubectl delete ns "$SYNTH_KUBERNETES_NAMESPACE" --wait=true`.

Full live gate (same env + PG + Pi checkout):

```bash
export SYNTH_K8S_LIVE='1'
export SYNTH_POSTGRES_URL='postgres://synth:synth@127.0.0.1:5432/synth'
export PI_REPO='/path/to/pi-checkout'
npm run live:proof
```

## 6. Troubleshooting (every one hit for real)

| symptom | cause | fix |
|---|---|---|
| `no runtime for "crun" is configured` | RuntimeClass object exists but no OCI runtime behind it | install runsc (§1–2), use `gvisor` |
| `resource name may not be empty` on apply | `runtimeClassName: ""` is rejected by the API | omit the key when empty (fixed in RC; never send `""`) |
| `sidecar "gvisor_sentry" not usable ... STRICT` | sentry binaries missing | install `gvisor-bin/` (§1) |
| `kubectl run --runtime-class-name: unknown flag` | flag doesn't exist in v1.33 | `--overrides` or manifest (§3) |
| probe pod `Forbidden: violates PodSecurity restricted` | namespace enforces restricted PSS | correct behavior — write a compliant manifest (§3) |
| gvisor bucket `latest: NoSuchKey` | symlink removed upstream | resolve tag via GitHub API (§1) |
| `tar: bzip2: Cannot exec` | missing decompressor | `apt-get install bzip2` |

## 7. Proven results (2026-09-19, this exact procedure)

- gVisor probe: `Running`, kernel `4.19.0-gvisor`, own dmesg, no host escape.
- kill-chaos on RC tag, gVisor + digest-pinned image: **3/3 green**
  (`exitCode: 137` every run, no false success).
- Full `live:proof` with `SYNTH_K8S_LIVE=1`: **PASS live Kubernetes Pod kill**.
- Cleanup verified: no pods/namespaces left behind.
