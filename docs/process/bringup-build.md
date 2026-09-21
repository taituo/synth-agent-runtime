# Bring-up build log — builder, machine `big`

Host: `ssh -i <ssh-key> tiny@<big-host>` (host `big`, internal 10.92.1.1).
k3s v1.33.2+k3s1, containerd://2.0.5-k3s1, Ubuntu 24.04.4, kernel 6.8.0-138-generic.
Started 2026-09-21. Builder appends; verifier owns `bringup-verification.md`.

## A1 — install gVisor

Command:
```
sudo -n apt-get install -y apt-transport-https ca-certificates curl gnupg
curl -fsSL https://gvisor.dev/archive.key | sudo -n gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo -n tee /etc/apt/sources.list.d/gvisor.list
sudo -n apt-get update -qq
sudo -n apt-get install -y runsc
```
Result:
```
Get:1 https://storage.googleapis.com/gvisor/releases release/main amd64 runsc amd64 20260914.0 [171 MB]
Unpacking runsc (20260914.0) ...
Setting up runsc (20260914.0) ...
---INSTALL EXIT 0---
```
Verified:
```
$ which runsc containerd-shim-runsc-v1
/usr/bin/runsc
/usr/bin/containerd-shim-runsc-v1
$ runsc --version
runsc version release-20260914.0
spec: 1.2.1
$ dpkg -l runsc | tail -1
ii  runsc          20260914.0   amd64        gVisor container sandbox runtime
$ sha256sum /usr/bin/runsc /usr/bin/containerd-shim-runsc-v1
c0f4ec0ac1198975d5cf919a78f2302426de096f69eebd33e50125c3ca42d699  /usr/bin/runsc
4b0c2a8eb7414d8b5f3d032e158784b454e9c98ffa3fdebbdd79047faf930d7c  /usr/bin/containerd-shim-runsc-v1
```
**Exact version installed: `runsc` package `20260914.0`, binary reports `runsc version release-20260914.0`, `spec: 1.2.1`. Both binaries are in `/usr/bin`, which is on the default PATH.**

Status: DONE

## A2 — containerd config template

Filename verified against the installed k3s before writing. Source evidence: k3s
`pkg/agent/containerd/config.go` at tag `v1.33.2+k3s1` declares
`templateGenerations` with `version: 3, filename: "config-v3.toml.tmpl"` first, and
`writeContainerdConfig` defaults to the v3 template. The generated config also
reports `version = 3`.

Command:
```
D=/var/lib/rancher/k3s/agent/etc/containerd
sudo -n cp -a "$D/config.toml" "$D/config-v3.toml.tmpl"
sudo -n tee -a "$D/config-v3.toml.tmpl" <<'BLOCK'

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
BLOCK
sudo -n systemctl restart k3s
```
(The template was copied from the config k3s had already generated, so every k3s
setting is preserved, then the `runsc` handler was appended.)

Result:
```
$ sudo -n ls -la $D/
-rw-r--r-- 1 root root 1398 ... config.toml
-rw-r--r-- 1 root root 1508 ... config-v3.toml.tmpl

$ sudo -n journalctl -u k3s --since "-10 min" | grep -i "config template"
Sep 21 07:16:37 big k3s[9497]: level=info msg="Using containerd config template at /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl"
```
Verified (read the regenerated config back, after restart):
```
$ sudo -n grep -n -A2 'runtimes.runsc' /var/lib/rancher/k3s/agent/etc/containerd/config.toml
45:[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
46-  runtime_type = "io.containerd.runsc.v1"

$ sudo -n k3s crictl info | grep -A30 '"runtimeHandlers"'
      "name": "runhcs-wcow-process"
      "name": "runsc"
      "name": "runc"
```
Node returned Ready 10 s after restart.

Status: DONE

## A3 — RuntimeClass with a node selector

Command:
```
sudo -n k3s kubectl apply -f - <<'YAML'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
scheduling:
  nodeSelector:
    synth.openai.dev/gvisor: "true"
YAML
```
Result:
```
runtimeclass.node.k8s.io/gvisor created
```
Verified:
```
$ sudo -n k3s kubectl get runtimeclass gvisor -o yaml
apiVersion: node.k8s.io/v1
handler: runsc
kind: RuntimeClass
metadata:
  name: gvisor
scheduling:
  nodeSelector:
    synth.openai.dev/gvisor: "true"
```

Status: DONE

## A4 — label the node

Command:
```
sudo -n k3s kubectl label node big synth.openai.dev/gvisor=true --overwrite
```
Result:
```
node/big labeled
```
Verified:
```
$ sudo -n k3s kubectl get node big -o jsonpath='{.metadata.labels.synth\.openai\.dev/gvisor}'
true
```

Note: A3 was applied before A4. A gVisor smoke pod was then created in `default`
and it ran; see the combined A1–A4 smoke observation below. Probe deleted.

Additional observation (A1–A4 end-to-end, probe, not a gate declaration):
```
$ sudo -n k3s kubectl apply -f gvisor-smoke.yaml   # runtimeClassName: gvisor, busybox
pod/gvisor-smoke created
phase=Pending (1)
phase=Succeeded (2)
Events: Scheduled -> Pulled (already present) -> Created -> Started
$ sudo -n k3s kubectl logs gvisor-smoke
Linux gvisor-smoke 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016 x86_64 GNU/Linux
---
Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016
```
The RuntimeClass nodeSelector routed the pod via the label; the kernel string is
gVisor. `kubectl delete pod gvisor-smoke` completed; pod confirmed gone.

Status: DONE

## B3 — namespaces and RBAC

Cloned from origin on `big` (github_ed25519 authenticates as `taituo`):
```
$ git clone git@github.com:taituo/synth-agent-runtime.git synth-agent-runtime
$ git log --oneline -1
eac94c9 Final: verified README numbers, durable claim audit
$ git rev-parse HEAD
eac94c9c899e80dc7f6fd1765024faf150d688e7
```
Applied unchanged from `deploy/kubernetes/`:
```
$ sudo -n k3s kubectl apply -f deploy/kubernetes/sandbox-namespace.yaml
namespace/synth-sandboxes created
$ sudo -n k3s kubectl apply -f deploy/kubernetes/egress-namespace.yaml
namespace/synth-egress created
$ sudo -n k3s kubectl apply -f deploy/kubernetes/control-plane-namespace.yaml
namespace/synth-control-plane created
$ sudo -n k3s kubectl apply -f deploy/kubernetes/control-plane-rbac-sandbox.yaml
serviceaccount/synth-control-plane created
role.rbac.authorization.k8s.io/synth-sandbox-controller created
rolebinding.rbac.authorization.k8s.io/synth-sandbox-controller created
```
Verified:
```
$ sudo -n k3s kubectl get ns synth-sandboxes synth-egress synth-control-plane --show-labels
synth-sandboxes       Active   ... pod-security.kubernetes.io/enforce=restricted,...,synth.openai.dev/managed=true
synth-egress          Active   ... pod-security.kubernetes.io/enforce=restricted,synth.openai.dev/egress=true
synth-control-plane   Active   ... pod-security.kubernetes.io/enforce=restricted,...,synth.openai.dev/control-plane=true

$ sudo -n k3s kubectl -n synth-sandboxes get role synth-sandbox-controller -o jsonpath='{range .rules[*]}{.apiGroups}{" "}{.resources}{" -> "}{.verbs}{"\n"}{end}'
[""] ["pods"] -> ["get","list","watch","create","delete"]
[""] ["pods/exec"] -> ["create"]
["networking.k8s.io"] ["networkpolicies"] -> ["get","list","create","update","patch","delete"]

$ ... -o json | grep -i secret
(no output — no secrets verb/resource)
$ sudo -n k3s kubectl -n synth-sandboxes get rolebinding synth-sandbox-controller -o jsonpath='{.subjects}'
[{"kind":"ServiceAccount","name":"synth-control-plane","namespace":"synth-control-plane"}]
```
Pod-security `enforce: restricted` is present on `synth-sandboxes` (and the other two).
`runtimeclass-gvisor.yaml` was NOT applied in B3 — A3's RuntimeClass (with the
scheduling nodeSelector) is the one in the cluster.

Status: DONE

## A7 — admission-level enforcement

Applied `/tmp/opencode/a7-validatingadmissionpolicy.yaml` (exact contents):
```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: synth-sandbox-require-gvisor
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: synth-sandboxes
  validations:
    - expression: "has(object.spec.runtimeClassName) && object.spec.runtimeClassName == 'gvisor'"
      message: "pods in namespace synth-sandboxes must set spec.runtimeClassName to 'gvisor'"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: synth-sandbox-require-gvisor
spec:
  policyName: synth-sandbox-require-gvisor
  validationActions: ["Deny"]
```
Command:
```
sudo -n k3s kubectl apply -f /tmp/opencode/a7-validatingadmissionpolicy.yaml   # piped over ssh
```
Result:
```
validatingadmissionpolicy.admissionregistration.k8s.io/synth-sandbox-require-gvisor created
validatingadmissionpolicybinding.admissionregistration.k8s.io/synth-sandbox-require-gvisor created
```
Verified — policy present, no type-checking errors:
```
$ sudo -n k3s kubectl get validatingadmissionpolicy synth-sandbox-require-gvisor -o jsonpath='{.spec.failurePolicy}'
Fail
$ ... -o jsonpath='{.status}'
{"observedGeneration":1,"typeChecking":{}}
```

Verified — discriminating probe. All three pods use an identical restricted-PSS
securityContext (`runAsNonRoot`, uid 65534, `allowPrivilegeEscalation:false`,
`capabilities.drop:[ALL]`, `seccompProfile: RuntimeDefault`), differing ONLY in
`runtimeClassName`; the positive control passing PSS proves the denials below are
the VAP, not PodSecurity:
```
########## CASE 1: runtimeClassName UNSET (expect DENY) ##########
The pods "a7-probe-unset" is invalid: : ValidatingAdmissionPolicy 'synth-sandbox-require-gvisor' with binding 'synth-sandbox-require-gvisor' denied request: pods in namespace synth-sandboxes must set spec.runtimeClassName to 'gvisor'
exit=1

########## CASE 2: runtimeClassName=crun (expect DENY) ##########
The pods "a7-probe-crun" is invalid: : ValidatingAdmissionPolicy 'synth-sandbox-require-gvisor' with binding 'synth-sandbox-require-gvisor' denied request: pods in namespace synth-sandboxes must set spec.runtimeClassName to 'gvisor'
exit=1

########## CASE 3 (control): runtimeClassName=gvisor (expect ADMIT+RUN) ##########
pod/a7-probe-gvisor created
exit=0
control phase=Succeeded
Linux a7-probe-gvisor 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016 x86_64 GNU/Linux
```
Cleanup: `a7-probe-gvisor` deleted; `kubectl -n synth-sandboxes get pods` → "No
resources found". The two denied pods were never created.

Status: DONE

## A5 — Node 22

Install (official release tarball, same version as the prepared artifact on `tiny`):
```
$ curl -fsSL -o /tmp/node-v22.20.0-linux-x64.tar.xz https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz
download OK
$ sha256sum /tmp/node-v22.20.0-linux-x64.tar.xz
00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc
$ sudo -n tar -xJf /tmp/node-v22.20.0-linux-x64.tar.xz -C /usr/local --strip-components=1
$ which node npm ; node --version ; npm --version
/usr/local/bin/node
/usr/local/bin/npm
v22.20.0
10.9.3
$ sha256sum /usr/local/bin/node
b1cbec894e45a5814b6ab756e1e14f8a76516273197e67e0412b57c1e10d0d9f
```
`/usr/local/bin` precedes `/usr/bin`, so `node` resolves to v22.20.0 (was v18.19.1).
Dependencies installed with `npm ci` (package-lock.json present; 4 packages).

Command (as specified):
```
cd ~/synth-agent-runtime
rm -rf dist && npm test
```

Result — run 1 (cold fixture cache), Node v22.20.0:
```
# tests 287
# pass 275
# fail 5
# skipped 7
```
Failing: 110, 112, 134, 258, 280.

Result — run 2 (fixture cache now warm), Node v22.20.0:
```
# tests 287
# pass 279
# fail 1
# skipped 7
```
Failing: 112 only.

Result — control, same compiled `dist` run under system `/usr/bin/node v18.19.1`:
```
# tests 287
# pass 251
# fail 28
# skipped 8
```

Verified — the single remaining Node-22 failure is defect 1, the test pinned to `tiny`:
```
not ok 112 - the boundary contract rejects a local run (it can read the host vectors)
  error: |-
    the local runner sees the host repo
    false !== true
  location: dist/test/gym-sandbox-boundary.test.js:113:1
```
and the source constants it depends on:
```
test/gym-sandbox-boundary.test.ts:35: const HOST_REPO = "/home/tiny/projects/pisynth/synth-agent-runtime";
test/gym-sandbox-boundary.test.ts:36: const HOST_NODE_IP = "10.91.1.1";
test/gym-sandbox-boundary.test.ts:37: const CLUSTER_API = "10.43.0.1";
```
On `big` the clone is at `/home/tiny/synth-agent-runtime`, so `existsSync(HOST_REPO)` is
false and the control arm's "host repo is visible" assertion fails. This is exactly the
plan's defect 1 (fix scheduled as C1), not a Node-22 regression.

Characterisation of run 1's 4 extra failures (110, 134, 258, 280): all are fixture-repo
git operations. `test/fixtures/real-repos.ts:21` points the cache at
`/tmp/opencode/fixture-repos`; on a cold `big` the cache was created during run 1 and
several test files cloned into the same shared path concurrently (`git clone --bare`
into `${cacheRoot()}/${name}.git` with no lock). After the caches warmed, 110/258/280
passed in run 2. Direct evidence that the pins are still fetchable (probe, then removed):
```
git init -q --bare /tmp/probe-he.git
git -C /tmp/probe-he.git fetch -q --depth=1 https://github.com/mathiasbynens/he 36afe179392226cf1b6ccdb16ebbb7a5a844d93a   # rc=0
git init -q --bare /tmp/probe-cmd.git
git -C /tmp/probe-cmd.git fetch -q --depth=1 https://github.com/tj/commander.js ba6d13ddb4243e5913367734f8c159089ffe7834   # rc=0
```
So the run-1 failures were a cold-cache concurrency race, not stale pins. Run 2 (279/287)
is the steady-state number on a warm fixture cache.

Interpretation (numbers, not conclusions): under the required Node 22 the suite is
**not fully green** (1 deterministic failure, defect 1). Under Node 18 the same code
fails 28 — many of those are Node-22-only features (`node:sqlite`, the permission model)
that the confinement/forge tests exercise. The `engines: >=22` requirement is therefore
real: v22 is strictly better than v18, and the one v22 failure is unrelated to the Node
version.

Status: DONE (requirement resolved: >=22 upheld; suite not green on `big`, 1 known failure = defect 1)

## A6 — optional (disable traefik/servicelb, kubelet system-reserved)

Not applied. The brief marks A6 optional and not blocking, and applying it restarts k3s
and changes node configuration immediately before verification. Left untouched so the
cluster stays in a stable, inspectable state for the verifier.

Status: SKIPPED

## Follow-up (defect found by the owner) — invariant only existed on the cluster

Finding: A3's `scheduling.nodeSelector` and A7's ValidatingAdmissionPolicy existed
only as live objects on `big`. `deploy/kubernetes/runtimeclass-gvisor.yaml` in git
had no selector, and there was no admission-policy manifest anywhere, so a clean
bring-up from the repo got neither.

Fix (commit `dee0dd4` on `main`, local; parent `30a1d4a` = `origin/main`):
```
$ git show --stat --oneline HEAD
dee0dd4 Deploy: enforce the gVisor invariant from the repo, not just live objects
 deploy/kubernetes/README.md                     | 17 +++++++++++++++-
 deploy/kubernetes/runtimeclass-gvisor.yaml      |  3 +++
 deploy/kubernetes/sandbox-gvisor-admission.yaml | 26 +++++++++++++++++++++++++
 3 files changed, 45 insertions(+), 1 deletion(-)
```
- `runtimeclass-gvisor.yaml` now carries the `scheduling.nodeSelector` for
  `synth.openai.dev/gvisor: "true"`.
- `sandbox-gvisor-admission.yaml` is the VAP + binding, byte-identical to what is
  applied on `big` (`diff` reported IDENTICAL).
- `README.md` §1 now documents the node label step and the admission policy, so a
  plain bring-up applies both.
Only these three paths were staged; the tree's unrelated in-progress changes
(`CHANGELOG.md`, `scripts/live-proofs.mjs`, `docs/fault-matrix*`, `integrations/**/fault-*.ts`)
were left untouched. CHANGELOG was deliberately not edited (it is being modified by
other in-flight work).

Status: DONE (committed locally; not pushed — see note to owner)

Push outcome (correction to the line above): `git push origin main` returned
"Everything up-to-date"; `git branch -r --contains dee0dd4` → `origin/main`, and
`git merge-base --is-ancestor dee0dd4 origin/main` → YES. The commit is on origin
(`origin/main` is now `78833f2`, which has `dee0dd4` as an ancestor; a concurrent
commit landed on top). `git ls-tree origin/main -- deploy/kubernetes` lists
`sandbox-gvisor-admission.yaml`, and `runtimeclass-gvisor.yaml` at origin has the
`nodeSelector`. **The invariant is in git on origin.**
