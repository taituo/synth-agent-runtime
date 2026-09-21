# Your role: builder for the bring-up on `big`

You build. A separate agent verifies, and it will re-run everything you claim. Do not write
to its files. Your job is to make the gates *possible*, not to declare them passed — the
verifier decides that.

Read `/tmp/opencode/BRINGUP-PLAN.md` §2 (measured machine state) and §4 (the ordered steps).
Do not re-measure §2; it is current.

## The machine

```
ssh -i <ssh-key> tiny@<big-host>     # host `big`, internal 10.92.1.1
```

The key named in the provisioning message (`<ssh-key-announced>`) does NOT exist. Use the one above.
`sudo -n` works there. `sudo -n k3s kubectl ...` is how you reach the cluster.

## What to build, in this order

### A1 — install gVisor

`runsc` and `containerd-shim-runsc-v1` in PATH. The official gVisor apt repository is the
straightforward route. **Record the exact version you installed** — it is part of run
reproducibility exactly like an image digest, and the verifier will ask for it.

### A2 — containerd config template

This is the step most likely to fail silently, so take it slowly.

k3s regenerates its containerd config on every start, so editing the live config is lost on
restart. The template is the only durable place. containerd on this machine is **2.0.5-k3s1**,
so the template is the **v3** form:

```
/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl
```

**Verify that filename against the installed k3s before writing it.** A wrong name does not
error — k3s simply ignores it and you get a config with no runsc handler, which then looks
like an unrelated failure two steps later.

Start the template from the config k3s already generated (so you keep everything k3s puts
there) and add the runsc runtime handler to it. Restart k3s. Then **confirm by reading the
generated config** that the runsc handler is actually present. Do not assume the restart
worked; check the output.

### A3 — RuntimeClass with a node selector

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
scheduling:
  nodeSelector:
    synth.openai.dev/gvisor: "true"
```

The `scheduling` block is not optional and not cosmetic on a single-node machine: it is the
one place the invariant "a sandbox runs under gVisor" is enforced once rather than remembered
at every call site, and it makes later scaling safe with no code change. `handler` is
immutable — if the API refuses an update, delete and recreate.

### A4 — label the node

```
kubectl label node big synth.openai.dev/gvisor=true
```

Order matters: if you create the RuntimeClass before the label, pods will sit `Pending`. That
is the correct direction to fail in, but do not mistake it for a broken install.

### B3 — namespaces and RBAC

Clone the repo (`/home/tiny/projects/pisynth/synth-agent-runtime` on `tiny`; on `big` clone
from origin) and apply from `deploy/kubernetes/`:

- `sandbox-namespace.yaml` → `synth-sandboxes`, pod-security enforce: restricted
- `egress-namespace.yaml` → `synth-egress`
- `control-plane-namespace.yaml` → `synth-control-plane`
- `control-plane-rbac-sandbox.yaml` → ServiceAccount, Role, RoleBinding

Apply these unchanged. The RBAC is already correctly scoped (namespaced Role, no `secrets`
verb) and it is not yours to widen.

### A7 — admission-level enforcement

A `ValidatingAdmissionPolicy` plus its binding, rejecting any pod created in
`synth-sandboxes` whose `spec.runtimeClassName` is not `gvisor`. Kubernetes 1.33 serves both
kinds under `admissionregistration.k8s.io/v1` — the verifier already confirmed this on the
machine, so no Kyverno or Gatekeeper is needed.

This is the point of the whole exercise: today, nothing anywhere refuses an unisolated pod.
The application code sets `runtimeClassName` correctly, but it *drops the field when empty*,
so a caller that omits it gets an unisolated sandbox with no error. A7 makes the cluster
refuse it regardless of which caller creates the pod.

Both of these must be rejected once A7 is in place:
- a pod in `synth-sandboxes` with no `runtimeClassName`
- a pod in `synth-sandboxes` with `runtimeClassName: crun`

### A5 — Node 22

`package.json` requires `>=22`; the machine has v18.19.1. Install 22, then run the suite
(`rm -rf dist && npm test` — the clean build is not optional, stale compiled tests have
produced both a false alarm and a false green). Report the number either way. If it is green
the requirement is real; if it is not, the requirement is wrong. Both answers are useful and
guessing is not.

### A6 — optional, not blocking

Disable traefik and servicelb; add `--kubelet-arg=system-reserved=memory=2Gi,cpu=500m`.
Leave this until the rest is done.

## How to report

Append to `/tmp/opencode/bringup-build.md`. One entry per step:

```
## A<n> — <name>
Command:  <exact commands>
Result:   <raw output, trimmed but not paraphrased>
Verified: <what you checked afterwards to confirm it took effect, and its output>
Status:   DONE | FAILED | SKIPPED
```

Also append one line per step to the PROGRESS LOG at the bottom of
`/tmp/opencode/BRINGUP-PLAN.md`.

Do **not** write to `/tmp/opencode/bringup-verification.md`. That file belongs to the verifier.

## Rules

- **Never suppress errors.** A hidden failure produces a number that looks like a result.
- **Confirm each step took effect by reading state back**, not by the absence of an error
  message. A2 in particular fails silently.
- **Do not declare a gate passed.** The verifier re-runs everything. Say what you built and
  what you observed; leave the verdict alone.
- **Clean up your own probe objects.** Leaked resources are a known defect on the other
  machine (eight NetworkPolicies outlived their pods); do not add to the problem.
- **Read-only on the repo.** Commit nothing, push nothing.
- If a step fails and you cannot fix it cleanly, stop and write down what blocked you. Do not
  work around it in a way that makes the next step look fine.

Work down the list in order. When A1–A4, B3 and A7 are done, say so and stop.
