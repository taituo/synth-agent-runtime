# Brief for synth-orch — the setup changed today

Short version: there is now a second machine. **You develop on `tiny`. Verification happens
on `big`.** Nothing you are doing needs to stop; this tells you where things run now, and
what the next direction is.

---

## 1. The two machines

| | `tiny` (here) | `big` (new) |
|---|---|---|
| role | development, builds, the repo | verification, real runs |
| cluster | k3s, shared with other projects | k3s, clean, only this project |
| memory | 15 Gi, ~3 Gi free (opencode uses 6.4) | 22 Gi, mostly free |
| disk | 150 G | 451 G, 428 free |
| gVisor | RuntimeClass only, no enforcement | installed and enforced |
| ssh | — | `ssh -i <ssh-key> tiny@<big-host>` |

The key named in the provisioning message (`<ssh-key-announced>`) does not exist. Use the one above.
`sudo -n k3s kubectl ...` works there.

Why the split: `tiny` cannot host a real run — 3 Gi free, and one run needs ~6. More
importantly a clean machine is the only place a bring-up can be *proven*, because nothing has
accumulated there.

---

## 2. What was built on `big` today

- gVisor installed (`runsc 20260914.0`), containerd configured durably (the template filename
  was verified against the k3s source, not guessed — it fails silently if wrong).
- `RuntimeClass gvisor` with `scheduling.nodeSelector`, node labelled.
- Namespaces `synth-sandboxes`, `synth-egress`, `synth-control-plane` + the RBAC from
  `deploy/kubernetes/`, applied unchanged.
- **A `ValidatingAdmissionPolicy` that refuses any pod in `synth-sandboxes` without
  `runtimeClassName: gvisor`.** This is the significant one.

Measured, three cases:

```
no runtimeClassName   → REFUSED by the policy
runtimeClassName crun → REFUSED by the policy
runtimeClassName gvisor → allowed; inside: uname 4.19.0-gvisor,
                          runtimeType io.containerd.runsc.v1
```

What changed in kind: previously the code set `runtimeClassName` correctly but **dropped the
field when empty**, so a caller that omitted it got an unisolated sandbox with no error.
Isolation depended on someone remembering. Now the cluster refuses, regardless of caller.

Also settled with a control: `engines: >=22` is real. Node 22 → 279/287 pass (1 failure =
the boundary test hardcoded to `tiny`). Node 18 → 251/287. Not a judgement call any more.

---

## 3. The agents now running

- `bringup-build` — builder on `big`. Reports to `/tmp/opencode/bringup-build.md`.
- `bringup-verify` — verifier. Re-runs everything the builder claims. Owns
  `/tmp/opencode/bringup-verification.md`. It does not build; it refused to install a missing
  prerequisite to get a green, which is the behaviour we want.

Roles are deliberately separated and they do not write to each other's files. This already
paid off: the verifier found that a gate I had written was incoherent.

---

## 4. Files

- `/tmp/opencode/BRINGUP-PLAN.md` — the plan. §2 measured machine state (do not re-measure),
  §3 nine known defects, §4 steps + gates, §5 decisions for the owner, PROGRESS LOG at the end.
- `/tmp/opencode/BUILD-BRINGUP.md`, `/tmp/opencode/VERIFY-BRINGUP.md` — the two role briefs.
- `/tmp/opencode/ROADMAP.md` — has a pointer at the top; the bring-up outranks the old queue.

---

## 5. The direction you asked about — what "comprehensive tests" means here

There are 287 tests. **More tests is not the ask.** Twice today a check passed for the wrong
reason, including one of mine. A test that passes for the wrong reason is worse than a missing
test, because it manufactures confidence nothing backs.

Six requirements, in priority order:

1. **Every refusal needs three cases** — two that must be refused, one that must succeed. A
   rule that refuses everything is as useless as one that refuses nothing, and without the
   third case you cannot tell them apart. Today's A/B/C above is the shape; copy it for every
   security claim.
2. **A negative assertion needs a positive control first.** Before a test claims "X cannot
   reach Y", it must show that Y *is* reachable under control conditions. Otherwise it is
   measuring a closed door, not a lock. `test/gym-sandbox-boundary.test.ts` has four network
   assertions and two of them are vacuous this way — the ports were not open from the host
   either. This is the single most important piece of test debt.
3. **One variable at a time.** The probe must satisfy every other requirement and differ only
   in the thing under test. I made exactly this mistake today: my first unisolated-pod probe
   was refused by PodSecurity, not by the policy I was testing, and I nearly recorded it as a
   pass.
4. **No machine-pinned tests.** The boundary test hardcodes `/home/tiny/projects/...`,
   `10.91.1.1`, `10.43.0.1`. It is the one red test right now. Parameterise it.
5. **Cleanup is a tested property.** Zero leftovers after a run. On `tiny` eight
   NetworkPolicies outlived their pods, and that leak had been fixed once before. A leak that
   is not in a test comes back.
6. **A fault matrix, not scattered fault tests.** Each dependency removed in turn, and for
   each the same four questions: is it retried, is data lost, is a human needed, can a side
   effect happen twice. Right now these are proven one at a time in separate harnesses.

**The rule underneath all six:** a test is not verified until it has been seen to fail. If you
cannot make it fail on purpose, it is an observation, not evidence.

---

## 6. What is still undone

The big one is unchanged: **the system has never been run as a whole.** `big` has no Temporal,
no Postgres, no gateway, no worker. The chain `agentId → workflow → effect → sandbox → pod →
receipt` has not once been executed in a single run. Every proof is still a partial proof in
its own harness.

Also open: the boundary test's machine pinning and its two vacuous assertions; egress is
undecided (the NetworkPolicy points at a proxy that does not exist — build one or close egress,
either is fine, the current state is not); workspace does not survive a crash (the Postgres
table `synth_workspace_checkpoints` exists, the wiring does not); `durableAgentWorkflow` has no
`continueAsNew`; no load test, no concurrency cap, no multi-tenancy.

`SYNTH_REQUIRE_ISOLATION` is still opt-in in application code. The admission policy now covers
the cluster path, which is the important half, but the code-level default is still fail-open.

---

## 7. What would help most from you

Pick from §5 and §6 rather than starting something new. In rough order of value:

1. Parameterise the boundary test (§5.4) — it unblocks verification on `big`.
2. Give its network assertions a positive control (§5.2) — or delete them and say so. Do not
   leave assertions that pass for the wrong reason.
3. Decide egress, then implement the decision.
4. Wire the workspace checkpoint that already has a table.

Build on `tiny`, verify on `big`. Coordinate through the PROGRESS LOG in `BRINGUP-PLAN.md` so
nothing is done twice.
