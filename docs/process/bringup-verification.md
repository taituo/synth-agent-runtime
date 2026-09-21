# Bring-up verification on `big` — independent verifier log

Verifier: synth-verify (read-only on the repo, builds nothing). Host: `big`, kernel
6.8.0-138-generic, k3s v1.33.2+k3s1. All state below was measured on the machine, not taken
from a report.

---

## G1 — gVisor runs (pod with `runtimeClassName: gvisor`)

Expected: with Phase A undone there is no `gvisor` RuntimeClass, no node label and no `runsc`,
so the pod must **not** end up under gVisor. The plan lists the passing failure as a Pending
pod (selector works, label missing). I expected either Pending or an admission rejection.

Command:
```
kubectl create namespace verify-g1
kubectl -n verify-g1 label ns verify-g1 pod-security.kubernetes.io/enforce=privileged
kubectl apply -f g1.yaml   # busybox, runtimeClassName: gvisor, sleep 3600
```
Result (raw):
```
Error from server (Forbidden): error when creating "/tmp/g1.yaml": pods "g1-gvisor" is
forbidden: pod rejected: RuntimeClass "gvisor" not found
```
The pod was never created; `describe pod g1-gvisor` → `NotFound`.

Prerequisite audit that explains it (all measured, all absent):
```
which runsc containerd-shim-runsc-v1   → command not found
kubectl get runtimeclass               → only the 10 k3s defaults (crun lunatic nvidia
                                         nvidia-experimental slight spin wasmedge wasmer
                                         wasmtime wws); no `gvisor`
node big label synth.openai.dev/gvisor → (empty)
```
Control: G2 below. Verdict: **NOT RUN** — prerequisite (BRINGUP-PLAN A1–A4) missing. The gate
as written cannot be reached. Note this is a *different* failure mode from the one the plan
anticipates: with the RuntimeClass object itself absent the API server rejects the pod
(`Forbidden`, never scheduled), it does not sit `Pending`. "Pending also passes" does not
cover the missing-RuntimeClass case, so if the builder later adds the RuntimeClass but misses
the node label the distinction will matter.

---

## G2 — without RuntimeClass it does not run (G1's control)

Expected as literally written in BRINGUP-PLAN §4 / VERIFY-BRINGUP line 26: the same pod with
no `runtimeClassName` "must NOT end up running on the default runtime". I expect that
expectation to be impossible under this cluster's configuration: there is no default
RuntimeClass (checked: every RuntimeClass has `is-default-class` empty), so a pod with no
`runtimeClassName` has nothing selecting it onto a gVisor node and will schedule normally on
the default runc runtime. I ran it to find out which is true.

Command: same pod manifest as G1 with the `runtimeClassName` line removed.
```
kubectl apply -f g2.yaml   # busybox, no runtimeClassName, sleep 3600
kubectl -n verify-g1 get pods -o wide
kubectl -n verify-g1 exec g2-default -- uname -a
kubectl -n verify-g1 get pod g2-default -o jsonpath='{.status.containerStatuses[0].containerID}'
sudo k3s crictl inspect <id> | grep -iE 'runtimeType|runtimeHandler'
```
Result (raw):
```
pod/g2-default created
NAME         READY   STATUS    RESTARTS   AGE     IP          NODE
g2-default   1/1     Running   0          21s     10.42.0.9   big
Linux g2-default 6.8.0-138-generic #138-Ubuntu SMP PREEMPT_DYNAMIC Fri Jul 31 22:41:49 UTC 2026 x86_64 GNU/Linux
    "runtimeType": "io.containerd.runc.v2",
    "runtimeHandler": "",
```
Control: this is itself the control for G1; the runnable counterpart (a `gvisor` pod) is G1,
which could not be created. Verdict: **FAILED** against the expectation as written (it DID
run, on the default runtime), and **DOES NOT DISCRIMINATE for G1** — G1 never created a pod,
so there is nothing for this control to attribute.

Findings, stated plainly:
1. The stated G2 expectation is inverted/self-contradictory. "Without RuntimeClass it does not
   run" and "must NOT end up on the default runtime" cannot both describe normal Kubernetes
   behaviour, and neither matches the measured result. The useful, defensible control is the
   opposite: a pod with no `runtimeClassName` runs on default runc (measured:
   `io.containerd.runc.v2`, kernel `6.8.0-138-generic`, no `gvisor`), which is what makes a
   future `uname` containing `gvisor` on the G1 arm attributable to `runtimeClassName`.
   Recommend the plan be corrected before G4 relies on it.
2. G2 passing/failing in its current wording proves nothing about isolation. As written it is
   a status assertion ("must not run"), and status assertions pass on broken configurations
   too (STANDING-ORDERS rule 5).

---

## Cleanup

`kubectl delete namespace verify-g1 --wait=true` → `deleted`. Post-cleanup
`kubectl get pods -A` shows only `kube-system` pods; `kubectl get ns verify-g1` → NotFound.
No probe pods or namespaces left behind. I created and deleted only my own namespace.

## Blockers / where I stopped

Phase A is not started: no `runsc`, no `containerd-shim-runsc-v1`, no `gvisor` RuntimeClass,
no `synth.openai.dev/gvisor` node label. Per my brief I do not install prerequisites to get a
green. G1 and G2 are therefore as far as it is meaningful to go until A1–A4 are done; G3 needs
the repo + Node 22, G4/G5/G6 need the later phases. Waiting on the builder.

---

## G2 (rewritten 2026-09-21) — pre-A7 arm: does the cluster admit an unisolated sandbox pod?

*Note: the G2 entry above stands as the record of the old, incoherent gate. This is the
rewritten gate (§4 A7/G2), not a re-run. It has two arms — before A7 (expected FAILS) and
after A7 (expected refuses) — and only the "before" state is measurable today.*

Expected before running: `synth-sandboxes` does not yet exist (B3 is Phase B, unbuilt), A7's
ValidatingAdmissionPolicy has not been applied, and with no admission policy anywhere the
cluster would admit an unisolated pod. I cannot run this at its actual target namespace
because that namespace does not exist, and I will not create it — B3 is builder work.

Command:
```
kubectl get ns
kubectl get ns synth-sandboxes
kubectl get validatingadmissionpolicy,validatingadmissionpolicybinding
kubectl api-resources | grep -i validatingadmission
```
Result (raw):
```
NAME              STATUS   AGE
default           Active   23m
kube-node-lease   Active   23m
kube-public       Active   23m
kube-system       Active   23m
Error from server (NotFound): namespaces "synth-sandboxes" not found
No resources found
validatingadmissionpolicies       admissionregistration.k8s.io/v1   false   ValidatingAdmissionPolicy
validatingadmissionpolicybindings admissionregistration.k8s.io/v1   false   ValidatingAdmissionPolicyBinding
```
Control: none possible — no policy exists to make fail, and no target namespace to probe.
Verdict: **NOT RUN** (blocked on B3 + A7). Two supporting measurements stand in for the
pre-A7 arm:
1. Zero `ValidatingAdmissionPolicy`/`Binding` objects exist cluster-wide, so nothing in this
   cluster refuses a pod on the basis of `runtimeClassName` anywhere, `synth-sandboxes`
   included. This is defect 3 measured at the cluster level: enforcement lives entirely in
   application code, exactly as §3 defect 3 states.
2. The old-G2 probe already produced the positive control for that statement — a pod with no
   `runtimeClassName` was admitted and ran under runc, no admission refusal.

Feasibility check for A7 (useful to the builder, not a pass): `admissionregistration.k8s.io/v1`
serves both `ValidatingAdmissionPolicy` and `ValidatingAdmissionPolicyBinding`, so A7 needs no
Kyverno/Gatekeeper and no feature-gate change on this k3s v1.33.2+k3s1.

The rewritten G2's premise is now correct and internally coherent — unlike the old wording, it
asks the cluster to refuse something it currently permits, which is a claim a control can
falsify. To directly record the pre-A7 FAIL inside `synth-sandboxes`, B3 must create the
namespace first; until then this arm is evidenced only indirectly.

---

## G1 — gVisor runs (re-run after A1–A4)

*The earlier G1 NOT RUN entry stands for that date. A1–A4 are now done; this is the independent
re-run.*

Expected before running: pod with `runtimeClassName: gvisor` reaches Running; `uname -a`
contains `4.19.0-gvisor`; `crictl inspect` on the same container reports the runsc runtime
(`io.containerd.runsc.v1`), not runc. If the node label were missing it would sit Pending; if
runsc were absent it would be scheduled and fail to start.

Command:
```
kubectl apply -f -   # busybox, runtimeClassName: gvisor, "uname -a; cat /proc/version; sleep 3600"
kubectl -n default get pod verify-g1-gvisor -o wide
kubectl -n default logs verify-g1-gvisor
cid=$(kubectl -n default get pod verify-g1-gvisor -o jsonpath='{.status.containerStatuses[0].containerID}')
sudo k3s crictl inspect ${cid#containerd://} | grep -iE 'runtimeType|runtimeHandler'
```
Result (raw):
```
pod/verify-g1-gvisor created
attempt 1 phase=Pending
attempt 2 phase=Running
NAME               READY   STATUS    RESTARTS   AGE   IP           NODE
verify-g1-gvisor   1/1     Running   0          6s    10.42.0.12   big
Linux verify-g1-gvisor 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016 x86_64 GNU/Linux
Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016
    "runtimeType": "io.containerd.runsc.v1",
      "runtimeHandler": "",
```
Independent prerequisite confirmation (measured, not taken from the build log): `runsc version
release-20260914.0` / spec 1.2.1 at `/usr/bin/runsc`, sha256 `c0f4ec0a…`; generated
`config.toml` carries `runtimes.runsc → io.containerd.runsc.v1`; `crictl info` lists handler
`runsc`; RuntimeClass `gvisor` handler `runsc` with nodeSelector `synth.openai.dev/gvisor=true`;
node `big` label value `true`.

Control: G2 below provides the contrasting arm — without the RuntimeClass the runtime is runc.
Within G1 itself, the two observations (`/proc/version` string via `uname`, and the CRI runtime
type) are independent, and they agree. `"runtimeHandler": ""` on the runsc container is normal
(the handler is named by `runtimeType` here, not that field) and is not a discrepancy.
Verdict: **PASSED**.

---

## G2 (rewritten) — cluster refuses an unisolated sandbox pod

Expected before running: A7's policy+binding exist with `failurePolicy: Fail`,
`validationActions: [Deny]`, matching `pods` CREATE/UPDATE in namespace `synth-sandboxes`, no
CEL type errors. In `synth-sandboxes`, a pod with `runtimeClassName` unset and one with
`runtimeClassName: crun` must both be refused at admission with the policy named; a pod with
`runtimeClassName: gvisor` must be admitted. All four probes use an identical restricted-PSS
securityContext (`runAsNonRoot`, uid/gid 65534, `allowPrivilegeEscalation:false`,
`capabilities.drop:[ALL]`, `seccompProfile: RuntimeDefault`), so the only variable is the
namespace and `runtimeClassName`.

Command:
```
kubectl apply -f g2-unset.yaml   # synth-sandboxes, no runtimeClassName
kubectl apply -f g2-crun.yaml    # synth-sandboxes, runtimeClassName: crun
kubectl apply -f g2-gvisor.yaml  # synth-sandboxes, runtimeClassName: gvisor  (control)
kubectl -n synth-sandboxes logs g2-gvisor
kubectl apply -f g2-deploy.yaml  # Deployment, no runtimeClassName (adversarial)
kubectl -n synth-sandboxes describe rs -l app=g2-deploy
```
Result (raw):
```
CASE 1 unset: The pods "g2-unset" is invalid: : ValidatingAdmissionPolicy
  'synth-sandbox-require-gvisor' with binding 'synth-sandbox-require-gvisor' denied request:
  pods in namespace synth-sandboxes must set spec.runtimeClassName to 'gvisor'      exit=1
CASE 2 crun:  <same denial message, "g2-crun">                                      exit=1
CASE 3 gvisor control: pod/g2-gvisor created (exit=0) → Running → logs:
  Linux g2-gvisor 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016 x86_64 GNU/Linux
CASE 4 Deployment (controller-created): deployment/g2-deploy created (Deployment itself is
  not matched), but the ReplicaSet never gets a pod:
    deployment.apps/g2-deploy   0/1  0  0
    replicaset.apps/g2-deploy-79db4fc9dc   1  0  0
    ReplicaFailure True FailedCreate
    Warning FailedCreate ... Error creating: pods "g2-deploy-79db4fc9dc-..." is forbidden:
      ValidatingAdmissionPolicy 'synth-sandbox-require-gvisor' ... denied request ...
```

Controls — how I tried to make it fail, and what happened:
1. **Isolate VAP from PodSecurity.** The identical unset manifest was applied in a scratch
   namespace `verify-pss` carrying the *same* `pod-security.kubernetes.io/enforce=restricted`
   label but no VAP. Result: `pod/g2-pss-unset created`, `1/1 Running` (exit 0). Same manifest,
   same PSS level, different namespace → admitted. Therefore the `synth-sandboxes` denial is
   the namespace-scoped VAP, not PSS.
2. **Positive control in the enforced namespace.** `runtimeClassName: gvisor` was admitted and
   ran (`4.19.0-gvisor`), so the namespace/policy does not simply reject everything.
3. **Scope control.** A no-runtimeClassName pod in `default` was admitted and ran (exit 0), so
   the policy does not break the rest of the cluster.
4. **Caller bypass.** A Deployment (controller-created pods, not a direct kubectl pod) with no
   `runtimeClassName` was equally refused — the ReplicaSet records `FailedCreate` naming the
   VAP. Enforcement does not depend on the caller.

Verdict: **PASSED**. The refusals are attributable to A7 (isolation control 1), the admit path
works (control 2), the policy is correctly scoped (control 3), and it holds for controller
callers (control 4).

Residual observations (not failures of G2, but worth recording):
- The policy keys on the *string* `runtimeClassName == 'gvisor'`; the actual isolation comes
  from RuntimeClass `gvisor`'s immutable `handler: runsc`. An actor with permission to delete
  and recreate the cluster-scoped RuntimeClass `gvisor` with `handler: runc` would defeat both
  G1 and G2 while every pod still reads `runtimeClassName: gvisor`. That permission is
  cluster-admin-tier, so this is an RBAC boundary to keep closed, not a defect in A7.
- Enforcement is scoped to namespace `synth-sandboxes` by design. A sandbox created in any
  other namespace is not covered by A7; the application's namespace choice is therefore part
  of the trust boundary.

## Cleanup (this round)

Deleted: `verify-g1-gvisor` (default), `g2-gvisor`, `g2-deploy` (synth-sandboxes),
`g2-pss-unset` (verify-pss), `g2-default-unset` (default), namespace `verify-pss`. Post-check:
`kubectl -n synth-sandboxes get pods,netpol` → "No resources found"; `kubectl get pods -A` →
only `kube-system`; `kubectl get ns verify-pss` → NotFound. No leaked pods, namespaces or
NetworkPolicies.
