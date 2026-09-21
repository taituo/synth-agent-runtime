# Bring-up plan: first end-to-end run on a clean machine

**Written 2026-09-21 by the Claude coordinator session.** Written so that if this session
runs out of context, anyone — another Claude, `synth-orch`, or a human — can continue
without re-deriving anything. Update the PROGRESS LOG at the bottom as you go.

Repo state this plan was written against: `origin/main` @ `0770895`.

---

## 1. Why this exists

An external reviewer asked for one reproducible end-to-end run: start from a commit, bring
up the environment, run one real agent against a real git repo, kill the worker mid-turn,
show the Temporal history, show the sandbox pod, show the final diff, show cleanup.

Checking the cluster showed the honest answer: **the system has never been run as a whole.**
Every durability and isolation claim is proven in its own separate harness. The chain
`agentId → workflow → effect → sandbox → pod → receipt` has never once been executed in a
single run. That is the project's largest single gap — larger than any individual defect
found in seven review rounds.

A separate clean machine was provisioned for this. A clean machine is the point: it is the
only place where the bring-up can be *proven*, because nothing has accumulated there.

---

## 2. Measured state — do not re-measure, this is current

### Machine `big` (new, clean)

```
SSH        ssh -i <ssh-key> tiny@<big-host>
           NOTE: the reported key <ssh-key-announced> does NOT exist on `tiny`.
           github_ed25519 works. Verified 2026-09-21.
internal   10.92.1.1
OS         Ubuntu 24.04.4 LTS, kernel 6.8.0-138-generic   (identical to `tiny`)
k3s        v1.33.2+k3s1                                   (identical to `tiny`)
containerd 2.0.5-k3s1   → config template is the **v3** form
cores      12          (reported as 16 — discrepancy, see §6)
memory     22 Gi       (reported as 32 — discrepancy, see §6)
disk       451 G, 428 G free
swap       off
kubectl    v1.33, in PATH
git        2.43.0
node       v18.19.1    ← package.json requires >=22. NOT MET.
runsc      MISSING
shim       containerd-shim-runsc-v1 MISSING
RuntimeClass gvisor    MISSING (10 others exist from k3s defaults)
node label synth.openai.dev/gvisor  MISSING
repo       not cloned
extras     traefik + servicelb running (recommended disabled, not blocking)
```

### Machine `tiny` (original, for reference)

Nothing of this system is deployed there either. Only PostgreSQL (`synth-audit-pg`) and the
`gvisor` RuntimeClass. No Temporal server listening on 7233. The gateway runs on
`127.0.0.1:8787` (loopback only). Host memory is the constraint there: 2.9 Gi free of 15.2,
with `opencode` alone using 6.4 Gi. That is why `big` exists.

---

## 3. Known defects that this work will hit

These were found during review and are **not** incidental — they will block or mislead.

1. **`test/gym-sandbox-boundary.test.ts` is pinned to `tiny`.** It hardcodes
   `HOST_REPO = /home/tiny/projects/pisynth/synth-agent-runtime`,
   `HOST_NODE_IP = 10.91.1.1`, `CLUSTER_API = 10.43.0.1`. On `big` the control arm
   (which asserts the host IS reachable locally) will fail. **Parameterise before running.**
2. **Two of four TCP assertions in that test do not discriminate.** On `tiny`, ports 7233
   and 8787 were not reachable from the host either (8787 binds loopback; 7233 had no
   listener), so "the pod cannot reach them" proves nothing. The control arm does not cover
   the network half at all: `assert.throws` fires on the first failing assertion, which is
   `gvisor === true`, so the network assertions never execute in the control.
3. **`runtimeClassName` is omitted when empty** (`src/execution/kubernetes/manifests.ts`),
   so a pod falls back to the default runtime rather than failing. All four resource classes
   set `"gvisor"`, so the default is correct — but enforcement is in application code, not
   admission policy.
4. **`SYNTH_REQUIRE_ISOLATION` is opt-in** (`src/gym/scoring.ts:376`). Default path runs
   agent code on the host. There is no `SYNTH_ALLOW_UNISOLATED` opt-out. Fail-open where it
   should be fail-closed.
5. **The egress proxy does not exist.** The generated sandbox NetworkPolicy allows egress
   only to DNS and TCP 3128 to `synth-egress-proxy` in a namespace labelled
   `synth.openai.dev/egress=true`. Neither the namespace nor the pod nor any implementation
   exists. See §5 decision (b).
6. **NetworkPolicies leak.** On `tiny`, eight `synth-sandbox-*-network` policies outlived
   their pods (oldest ~7 h, zero pods). CHANGELOG records a previous fix for this same leak.
7. **`durableAgentWorkflow` has no `continueAsNew`.** Only `runGraphWorkflow` does
   (`CONTINUE_AS_NEW_AFTER_NODES = 1000`). A long-lived agent's history grows unbounded.
8. **Workspace does not survive a crash.** Control-plane durability ≠ work-product
   durability: a resumed attempt read the BUGGED source at turn 0. Note that
   `synth_workspace_checkpoints` exists as a Postgres table — the structure is chosen, the
   wiring is missing.
9. **Node version.** `package.json` requires `>=22`; both machines have v18.19.1 and the
   suite passed anyway. The requirement has apparently never been tested. Resolve it, do not
   work around it.

---

## 4. The plan, in order

Each step has a gate. **A gate that has not been run is not passed. A skip is not a pass.**
State the expected result before running, so a surprise is visible as a surprise.

### Phase A — make the machine capable

**A1. Install gVisor.** `runsc` and `containerd-shim-runsc-v1` in PATH. Pin and record the
version — it is part of run reproducibility exactly like the image digest.

**A2. containerd config template.** k3s regenerates containerd config on every start, so
editing the live config is lost. The template is the only durable place:
`/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl` — containerd here is 2.x so
it is the **v3** form. Verify the exact filename against the installed k3s; a wrong name
fails silently. Restart k3s and confirm the generated config contains the runsc handler.

**A3. RuntimeClass with a node selector.**
```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: { name: gvisor }
handler: runsc
scheduling:
  nodeSelector:
    synth.openai.dev/gvisor: "true"
```
`handler` is immutable; if the API refuses an update, recreate the object. This is the one
place the invariant "a sandbox runs under gVisor" can be enforced once instead of being
remembered at every call site, and it makes later scaling safe with no code change.

**A4. Label the node.** `kubectl label node big synth.openai.dev/gvisor=true`

**A5. Node 22.** Install it, then run the suite. If green, the `>=22` requirement is real
and `tiny` was out of spec. If not green, the requirement is wrong. Either answer is useful;
guessing is not.

**A6. Optional:** disable traefik and servicelb, add
`--kubelet-arg=system-reserved=memory=2Gi,cpu=500m`. Not blocking.

**A7. Admission-level enforcement of the isolation invariant.** See G2 — this step was added
after the verifier showed the gate as originally written was incoherent. A
`ValidatingAdmissionPolicy` (k8s 1.33 has these built in, no Kyverno/Gatekeeper needed) that
rejects any pod in `synth-sandboxes` whose `spec.runtimeClassName != "gvisor"`. This is what
turns defect 3 from "application code sets it correctly" into an invariant the cluster
enforces regardless of which caller creates the pod.

> **GATE G1 — gVisor runs.** A test pod with `runtimeClassName: gvisor`; `uname -a`
> contains `gvisor`, AND `crictl inspect` on its container shows the runsc handler (the
> `/proc/version` string is one observation; the handler is a second, independent one).
>
> Three distinct failure modes, and they are NOT interchangeable — the verifier established
> this on 2026-09-21:
> - **No RuntimeClass object** → the API server rejects at admission:
>   `Forbidden: RuntimeClass "gvisor" not found`. The pod is never created. Not Pending.
> - **RuntimeClass exists, node label missing** → the pod IS created and sits `Pending`.
>   This one passes the gate, because it failed in the correct direction.
> - **RuntimeClass exists, label present, runsc missing on the node** → the pod is scheduled
>   and fails to start. This is the dangerous one to misread as a transient error.
>
> **GATE G2 — the cluster refuses an unisolated sandbox pod.** *(Rewritten 2026-09-21. The
> original wording — "a pod with no `runtimeClassName` must not run on the default runtime" —
> was wrong: that is exactly what Kubernetes does, by design, and nothing prevents it. The
> verifier ran it and reported the premise inverted. Corrected here rather than quietly
> dropped, because the mistake is instructive: I wrote a gate that could not pass, which is
> the same class of error as a gate that cannot fail.)*
>
> The real invariant: **in the `synth-sandboxes` namespace, a pod that does not request
> gVisor must be rejected by the cluster, not merely by application code.** Apply A7, then
> try to create a pod there with no `runtimeClassName` and with
> `runtimeClassName: crun`. Both must be refused at admission.
>
> **Expected result before A7 exists: FAILS.** That failure is itself the finding — it is
> defect 3 measured at cluster level, and it should be recorded, not worked around.

### Phase B — bring up the services

**B1. PostgreSQL.** Two consumers: Temporal persistence and the project's own world/artifact
store. Separate databases in one instance is fine. Schema from `deploy/postgres/001–003`.

**B2. Temporal with persistent storage — NOT `start-dev`.** This is a deliberate decision,
not a convenience choice. A dev server keeps state in memory, which means *worker* death is
testable but *Temporal* death is not. Since durability is the project's central claim, a dev
server would make the first run prove less than it appears to.

**B3. Namespaces and RBAC.** `synth-sandboxes` (pod-security: restricted), plus
`synth-egress` and `synth-control-plane` — both have manifests in `deploy/kubernetes/` and
neither has ever been created. RBAC from `control-plane-rbac-sandbox.yaml` unchanged; it is
already correctly scoped (namespaced Role, no `secrets` verb).

**B4. Gateway.** Bind to loopback or a private interface only. Provider key in the gateway's
environment. **The sandbox must never receive it.**

**B5. Pre-pull the executor image** by digest. `imagePullPolicy: IfNotPresent` means that
otherwise the first sandbox's startup latency is the image size, not a property of the system.

> **GATE G3 — suite green on a clean build.** `rm -rf dist && npm test`. State the expected
> count first.
>
> **GATE G5 — Temporal survives its own restart.** Restart Temporal, confirm the workflow
> continues. This is the gate a dev server fails, which is why it is a gate and not a note.

### Phase C — fix what blocks an honest measurement

**C1. Parameterise the boundary test** (defect 1). Host paths and cluster IPs from
environment, not literals.

**C2. Give the network assertions a control** (defect 2). Either assert against an endpoint
that IS reachable from the host (so denial in the pod means something), or drop the vacuous
assertions and say so. Do not leave assertions that pass for the wrong reason.

**C3. Decide egress** (defect 5, and §5 below).

> **GATE G4 — the isolation test runs and discriminates.** `SYNTH_LIVE_GVISOR=1`, with the
> control arm passing on the new machine.

### Phase D — the run itself

**D1. Worker on the host** for the first run. It reaches Temporal and the gateway over
loopback and creates sandboxes through the k8s API. Fewest moving parts, and it is how the
tests already work. Moving the worker into the cluster is its own later step requiring a
gateway binding change, a service account and a worker image — three new things that could
break at the same time as the thing being measured.

**D2. One agent, one real repo, one real change.** Log the full chain:
`agentId → Temporal Workflow ID → activity → effect.id → sandbox ID → pod → artifact/receipt`.
That chain, printed from one run, is the entire deliverable.

**D3. Kill the worker mid-turn.** Show Temporal history with `attempt=2`. Show that an
already-committed effect does not re-run. If an effect was left `started`, show
`EFFECT_OUTCOME_UNCERTAIN`.

**D4. Resume and finish.** Show what happened to the workspace — expect it NOT to survive
(defect 8). Record what was actually lost. Do not soften this; it is a known open item and
an honest result is worth more than a flattering one.

**D5. Final diff, test results, artifacts, receipts.**

> **GATE G6 — cleanup does not leak.** After the run,
> `kubectl get pods,netpol -n synth-sandboxes` is empty (defect 6).

---

## 5. Decisions that belong to the project owner

1. **Egress: DECIDED 2026-09-21 — (a), DNS-only.** Remove the proxy rule from the generated
   NetworkPolicy and fix the docs to match. Treat this as the likely *end* state, not a
   stopgap: the gym materialises the repo into the sandbox, so no network is needed. Build an
   allowlist only when a real task fails for lack of network, and derive it from what that
   task actually needed rather than from a guess. Original framing kept below for context.

   ~~**Egress: proxy or DNS-only?**~~
   (a) Write a minimal proxy (tinyproxy/squid) with a domain allowlist and an audit log —
   then the architecture matches the documentation.
   (b) Remove the proxy rule from the NetworkPolicy and leave egress as DNS only — then the
   documentation matches the architecture.
   Either is fine. The current state — a rule pointing at a pod that does not exist — is not,
   because it looks like a restriction without anyone having decided what is restricted.
2. **Worker on host or in cluster.** Recommendation: host first (D1).
3. **Sandbox concurrency cap.** A single machine caps itself, so this does not block the
   first run. But set the number now: it is the only thing separating a load test from a
   bill once there is more than one machine. There is currently **no admission or
   backpressure mechanism** for sandbox creation.

---

## 6. Open question for the owner

The machine was reported as cpx52, 16 vCPU / 32 GB. Measured: **12 cores, 22 Gi**. Enough
for the first run (needs ~6 Gi), but worth checking against billing, and it matters for the
later load test. Do not assume the reported figures.

---

## 7. Rules that apply to all of this

From `/tmp/opencode/STANDING-ORDERS.md`, and each one was learned by getting it wrong:

- **Attack it; do not read its tests.** The gym scorer was signed off four times by reading
  test names and forged four times in minutes.
- **Run the control.** A proof that only ever passes is not evidence. This is exactly how
  defect 2 above was found — in my own headline claim.
- **Check the call path**, not just that the code exists and its tests pass.
- **Verify the committed state in a separate worktree with `rm -rf dist` first.**
- **Never suppress errors in a verification command.** A hidden failure produces a number
  that looks like a result.
- **Suspect your own probe first** when a result confirms what you expected.
- **Say plainly when a result does not differentiate**, or when a fix does not help.
- **Report numbers, not conclusions.**

---

## PROGRESS LOG

Append here. One line per completed step, with what was measured, not what was intended.

- 2026-09-21 — Plan written. `big` provisioned and inspected; state recorded in §2.
  Nothing installed yet. No gate attempted.
- 2026-09-21 — Verifier: G1 NOT RUN. `kubectl apply` of a pod with `runtimeClassName: gvisor`
  → `Forbidden: ... RuntimeClass "gvisor" not found`. A1–A4 prerequisites still absent
  (`which runsc` → not found; no `gvisor` RuntimeClass; no node label). See
  `/tmp/opencode/bringup-verification.md`.
- 2026-09-21 — Verifier: G2 FAILED as written. Pod with no `runtimeClassName` DID run, on the
  default runtime (`runtimeType io.containerd.runc.v2`, `uname 6.8.0-138-generic`, no
  `gvisor`) with no default RuntimeClass present. The plan's stated expectation ("must NOT end
  up on the default runtime") is inverted; it also cannot control G1 because G1 created no pod.
  Probe namespace `verify-g1` created and deleted; no leaks.
- 2026-09-21 — Verifier, rewritten G2 pre-A7 arm: NOT RUN (blocked). `synth-sandboxes` does not
  exist yet (B3) and there are zero ValidatingAdmissionPolicy/Binding objects cluster-wide, so
  nothing refuses an unisolated pod anywhere — defect 3 measured at cluster level. Feasibility:
  `admissionregistration.k8s.io/v1` serves both VAP kinds, so A7 is possible with no add-on.
  G1 prereqs (runsc, gvisor RuntimeClass, node label) still absent.
- 2026-09-21 — Coordinator: G2 rewritten after the verifier showed the original premise was
  inverted. Added step A7 (ValidatingAdmissionPolicy) as the thing G2 actually tests. G1
  expanded with the three distinct failure modes the verifier distinguished. The verifier
  correctly reported G1 as NOT RUN rather than installing the prerequisite to get a green.
- 2026-09-21 — synth-orch (on `tiny`): read ORCH-BRIEF. Taking §7 items 1, 2 and 4, building on
  `tiny`, `main` (currently `eac94c9`). First: parameterise `test/gym-sandbox-boundary.test.ts`
  and give its four network assertions a real positive control (§5.2/§5.4). Then wire the
  workspace checkpoint (§7.4). No overlap with `big`'s builder/verifier; please do not
  parameterise the same file concurrently. Note: the plan's pin is `0770895`, `main` is 18
  commits ahead, so defect line numbers have moved.
- 2026-09-21 — Builder A1: installed gVisor apt package `runsc 20260914.0` (binary
  `release-20260914.0`, spec 1.2.1); `/usr/bin/runsc` and
  `/usr/bin/containerd-shim-runsc-v1` present. sha256 recorded in bringup-build.md.
- 2026-09-21 — Builder A2: wrote `/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl`
  (copied the generated config + appended `runtimes.runsc` → `io.containerd.runsc.v1`).
  Filename verified against k3s v1.33.2+k3s1 source. Restarted k3s; journal shows "Using
  containerd config template at .../config-v3.toml.tmpl"; regenerated config contains the
  runsc handler; `crictl info` lists handler `runsc`.
- 2026-09-21 — Builder A3: created RuntimeClass `gvisor` (handler runsc) with
  `scheduling.nodeSelector: synth.openai.dev/gvisor=true`; read back and confirmed.
- 2026-09-21 — Builder A4: labelled node `big` `synth.openai.dev/gvisor=true`; read back.
  Probe pod with `runtimeClassName: gvisor` ran (`uname` 4.19.0-gvisor), probe deleted.
- 2026-09-21 — Builder B3: cloned origin (`eac94c9`) and applied the four `deploy/kubernetes/`
  manifests. `synth-sandboxes`/`synth-egress`/`synth-control-plane` created with
  pod-security `enforce: restricted`; SA/Role/RoleBinding created; Role has pods,
  pods/exec, networkpolicies only and no `secrets` verb. Read back and confirmed.
- 2026-09-21 — Builder A7: applied ValidatingAdmissionPolicy + Binding
  `synth-sandbox-require-gvisor` (failurePolicy Fail; matches pods CREATE/UPDATE in
  namespace metadata.name=synth-sandboxes; requires runtimeClassName == 'gvisor').
  No type errors. Discriminating probe with identical restricted securityContexts:
  unset → DENIED, `crun` → DENIED, `gvisor` control → ADMITTED and ran under gVisor.
  Probes cleaned up; namespace empty.
- 2026-09-21 — Builder A5: installed Node v22.20.0 (npm 10.9.3) to /usr/local (official
  tarball sha256 00bbd05e…). `rm -rf dist && npm test`: run 1 (cold fixture cache) 287
  tests / 275 pass / 5 fail / 7 skip; run 2 (warm cache) 287 / 279 / 1 / 7; control under
  system Node v18.19.1 on the same dist: 287 / 251 pass / 28 fail / 8 skip. The one
  remaining v22 failure is #112, the `tiny`-pinned boundary test (defect 1), not a Node
  issue; the 4 extra run-1 failures were a cold-cache clone race in
  `test/fixtures/real-repos.ts`. `engines >=22` is real. Details in bringup-build.md.
- 2026-09-21 — Builder A6: SKIPPED (optional, not blocking); left cluster stable for
  verification.
- 2026-09-21 — Builder follow-up (owner finding): A3's selector and A7's policy were only
  live objects, not in git. Committed both as manifests on `main` — `dee0dd4` updates
  `deploy/kubernetes/runtimeclass-gvisor.yaml` with the node selector, adds
  `deploy/kubernetes/sandbox-gvisor-admission.yaml` (VAP + binding, byte-identical to the
  live object), and documents both in `deploy/kubernetes/README.md`. `origin/main` now
  contains `dee0dd4` (verified `git merge-base --is-ancestor`; `origin/main` = `78833f2`),
  so the invariant is in git on origin.
- 2026-09-21 — Verifier G1 (after A1–A4): PASSED. Pod `runtimeClassName: gvisor` → Running;
  `uname` `4.19.0-gvisor`; `crictl inspect` `runtimeType io.containerd.runsc.v1`. Prereqs
  re-measured independently (runsc release-20260914.0, handler in generated config, RuntimeClass
  handler runsc, node label true).
- 2026-09-21 — Verifier G2 (rewritten, after A7): PASSED. In `synth-sandboxes`, pods with
  runtimeClassName unset and `crun` both refused at admission by
  `synth-sandbox-require-gvisor`; gvisor pod admitted and ran (`4.19.0-gvisor`). Controls:
  identical unset manifest ADMITTED in a restricted-PSS namespace with no VAP (`verify-pss`)
  and in `default`, so the denial is the VAP not PSS and is namespace-scoped; a Deployment
  (controller-created pod) was equally refused (`FailedCreate`). Residual note: enforcement
  keys on the string 'gvisor' — recreating RuntimeClass `gvisor` with handler runc
  (cluster-admin-tier RBAC) would defeat it. All probes cleaned up; `synth-sandboxes` empty.
- 2026-09-21 — Owner decision: egress = DNS-only (option a). synth-orch implementing; docs
  to be corrected to match. An allowlist is deferred until a real task demonstrably needs one.
- 2026-09-21 — Owner decision on egress (§5.1): **(a) close it, DNS-only**, and treat (a) as the
  **likely end state, not a stopgap**. Remove the proxy rule and fix the docs. Rationale: the gym
  materialises the repo into the sandbox, so a scored run needs no network. An allowlist is built
  only when a real task fails for lack of network, derived from what that task needed — not a guess.
  synth-orch is implementing it on `tiny` (`TASK-egress-1`), after `boundary-1`.
- 2026-09-21 — **Phase 1 freeze (owner).** `merge-4` landed on `main` (`cf63d51`: workspace
  durability, per-pod netpol ownership, A/B/C). After one last doc-only commit (a `replaceInText`
  drift item in `KNOWN-OPEN.md`), **`main` is frozen for the duration of Phase 1**: no merges until
  the end-to-end run has happened or is shown blocked. Workers move to branches. The one exception
  is a defect the run itself proves necessary — that is Phase 1 work; anything else waits. Phase 1
  is `PHASE-1.md` (five steps, a check each, gym path `gymAttemptWorkflow` for the run), on `big`.
  `replaceInText`: correct call, do NOT fix; Phase 3 decides dead-code vs synthetic-rung need.
- 2026-09-21 — **Fix rule for Phase 1** (owner): `/tmp/opencode/fix-rule.md`. One discriminator:
  **does the fix change what the run proves?**
  1. *Obstacle* (wrong path, missing env var, typo, hardcoded value, stale image — one obvious
     remedy) → fix and continue, note it in the phase log. Do not stop for these.
  2. *Decision* (a design choice / more than one remedy / touches the harness, turn body or
     execution seam = DIRECTION territory / changes a published interface or manifest / would make
     the run **green rather than working**) → **stop and ask**. Making the run green instead of
     making the system work is the signal.
  3. *The failure IS the finding* (workspace not surviving a crash, `continueAsNew`, the vacuous
     network assertions, anything in §3) → **record precisely, do not repair**; repairing destroys
     the cleanest evidence. Default when unsure: **ask.**
- 2026-09-21 — synth-orch, Phase 1 on `big`: **P1.1 PostgreSQL DONE** (16.15; `synth` DB +
  `temporal` DB; schema 001–003; check: `synth_effects`/`synth_workspace_checkpoints` exist).
  **P1.2 Temporal DONE** (`docker.io` + `temporalio/auto-setup` → Postgres `DB=postgres12`;
  binds `127.0.1.1:7233`; check: trivial workflow COMPLETED, **restart → history survived**).
  **P1.3 Gateway DONE** (repo `createInferenceGateway` on `127.0.0.1:8787`, 2 profiles).
  **P1.4 Worker DONE** (one entry `worker-entry.js` RUNNING, poller `@big`).
  Obstacles fixed: private executor image imported from `tiny`; `http-upstream` path-prefix bug
  fixed (`e13e873`, failing-first test). **P1.5 BLOCKED — provider funds:** OpenCode Zen paid models
  return **402 Insufficient account funds**, free models are gated to "within OpenCode", and the
  `google` key is not an API key. Needs owner: fund the provider or supply another OpenAI-compatible
  key. Fallback proposed: scripted OpenAI-compatible model on loopback to produce the ID chain now.
- 2026-09-21 — **P1.5 DONE — Phase 1 complete.** Correction from the owner: a raw bearer to
  opencode.ai/zen is the refused "outside OpenCode" path; the real path is Pi ModelRuntime and
  `tiny:8787` works (27 models, 200). **Phase-1 shortcut (recorded):** an ssh reverse tunnel
  `tiny → big` (`ssh -N -R 8787:127.0.0.1:8787 tiny@big`) puts the working gateway on big's
  loopback; the run proves the chain, not where the model comes from (native gateway on big is a
  separate task). **One `gymAttemptWorkflow` run:** `gym-hex-decode` → workflow
  `gym-hex-decode-mub7uuug` (COMPLETED) → gymPrepareActivity + gymRunTurn ×5 + gymScoreActivity →
  sandbox pod `synth-sandbox-small-4b922cc4` (RUNNING in synth-sandboxes, gVisor) → Temporal
  activity-state receipt → **outcome passed, patch 358 B, servedModel kimi-k2.7-code**. Tool
  trajectory: list_files → read_file → replace_in_file → run_visible_test → finish. Pods cleaned up.
  Also fixed on the way: private executor image imported into big's k3s; `http-upstream` path-prefix
  bug (`e13e873`, failing-first). P1.1–P1.5 all done.
- 2026-09-21 — Queued, NOT done (main frozen): the gateway host script lives only in
  `/tmp/opencode/audit/pi/ogw-host.mts`, ~35 lines, with absolute `/tmp` imports. Every
  component it wires is committed (`integrations/pi-opencode-stack-router/src/inference/`,
  `integrations/opencode-http-gateway/adapter.ts`, `src/inference/gateway/server.ts`) — only
  the entrypoint that says how they connect and where keys come from is outside the repo.
  On reboot `/tmp` clears, the gateway dies and the subscriptions look unusable; that is how
  today's false "402, needs funding" diagnosis became plausible. Fix after P1.5: commit it as
  `integrations/opencode-http-gateway/host.ts` with relative imports and the accounts-file
  path from an env var, so `big` can run the gateway natively instead of tunnelling to `tiny`.
- 2026-09-21 — **Leak class: abandoned workflows.** The P1.5 run left
  `gym-hex-decode-mub65zrj` **Running** for ~1h (a client died mid-attempt). A Running workflow is
  invisible in `kubectl get pods`/`netpol` (those were clean) but holds history and a task-queue
  slot indefinitely. Terminated; `running_count 0` verified afterwards. Phase-1 hygiene going
  forward: any test/local driver must leave **zero Running workflows**, and verification should
  list Running before/after. This is a distinct leak class from the per-pod NetworkPolicies (§3.6).
- 2026-09-21 — Unapplied patch held at `/home/tiny/0001-Graph-decide-nodes-routing-on-a-typed-judgement.patch`
  (77 KB, by another Claude session). Adds `decide` graph nodes: state in, typed probabilistic
  answers out, route chosen by pure policy. Engine is external by design and the patch cites
  DIRECTION — orchestration above agents, so Synth still owns no agent intelligence. 31 tests,
  most asserting refusals (engine cannot name an undeclared route, cannot answer a different
  question, sees only the declared state); decision journaled before the work it selects, so a
  continue-as-new mid-child does not re-ask. Reviewed by reading only — NOT run. Do not merge on
  the strength of test names; that mistake is documented four times here. Also: the only caller
  is a demo, so record the absent production caller in KNOWN-OPEN if it lands. This is Phase 5
  work and Phase 3 has not happened.
