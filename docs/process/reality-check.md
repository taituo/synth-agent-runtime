# Reality check — `synth-agent-runtime`, whole project

Reviewer: synth-verify. Date: 2026-09-20. Read-only: no tracked file changed, no commit.
Refs: `main` @ `036121b`; local `gym-runner` @ `dfe33bd`; `origin/gym-runner` @ `2fc3642`;
`signal-swarm` @ `c300edb`. Context: `README.md`, `docs/*`, `CHANGELOG.md`,
`/tmp/opencode/ROADMAP.md`, `/tmp/opencode/review-findings.md` (rounds 1–7), `/tmp/opencode/MAP.md`.

Labels: **SOLID** = code or an executed result behind it; **LIKELY** = well-founded read;
**SPECULATIVE** = a hunch worth recording, not acting on. False positives are expected.

Executed for this check: `node --test dist/test/*.test.js` on `main` → **225/225 pass, 0 skip**
(README claims 73); CI workflow files read; the gym sandbox/local runner runs from the previous
round; module/consumer greps across `src`, `integrations`, `test`.

---

## 1. Is the project what its documentation claims?

**The pattern is: aspirational capability in the docs/CHANGELOG/README, dead or partial wiring in
the code, and a status section that does not track either.** Specifics:

- **SOLID — the release-facing README is stale by a wide margin.** `README.md:136` says
  `npm test … 73 passed / 0 failed`; the actual `main` root suite is **225** tests. `README.md:184`
  says `1.0.0-rc.1` "has closed every correctness/security issue found across two independent audit
  passes"; `docs/KNOWN-OPEN.md` (updated the same day) lists the scoring-worker isolation gap, the
  workspace-symlink flattening, the blob-store lifecycle gaps, the 8-item corpus, and unmeasured
  OpenRouter limits. The README's release status is not reconciled with the known-open list it
  points at.
- **SOLID — "isolated Kubernetes/gVisor sandbox" is a per-component property, presented as a
  system property.** The gVisor rung exists and the `kubernetes/` live proofs are real, but
  `.github/workflows/kubernetes-live.yml` is `workflow_dispatch` + a self-hosted runner, so it is
  not enforced per push; and on the gym path the sandbox runner is **non-functional** (measured:
  `run_visible_test` → `exit 127, sh: …/node: not found`; pod `git` → `dubious ownership`). The
  agent path the fault matrix actually used (`local` runner) has **no** permission model at all.
  The docs' isolation claim spans components that do not all have it.
- **SOLID — the Temporal adapter is dead.** `src/durability/temporal-adapter.ts` exports
  `TemporalDurabilityProvider`; the only reference anywhere is its own file and the barrel
  (`src/index.ts:20`). The real Temporal integration (`integrations/temporal/src/workflows.ts`)
  implements its own workflows/contracts. "Temporal-oriented adapters also included"
  (`README.md:11`) is true only in the sense that the file exists.
- **SOLID — a set of capabilities exist as exported types/modules with zero consumers.**
  `EffectPolicy`/`AllowlistEffectPolicy`/`ApprovalRequest`/`EffectDecision`
  (`src/policy/effect-policy.ts`, plus `PolicyEffectGate`) have **no** reference outside their own
  file, including tests. `InlineArtifact` (`src/core/types.ts`) — none. `DelegatedAgent` /
  `Supervisor` (`src/orchestration/supervisor.ts`) — only the barrel. `EffectReconciler`
  (`src/control-plane/effect-reconciler.ts`) — only `test/v08.test.ts`. `runDurableTurn`
  (`src/runtime/durable-turn.ts`) — none. These are documented-ish capabilities that no path calls.
- **LIKELY — this is a habit, not five accidents.** The repo keeps adding named subsystems
  (policy gate, reconciler, supervisor, transactional turn, artifact refs) faster than it wires
  them, and the docs describe the resulting architecture as if all were live. The same habit
  produced the isolation claim (round 6) and the earlier "unforgeable" scorer (rounds 4–6).

## 2. Is the architecture sound, or accumulating complexity faster than it earns it?

- **SOLID — the surface is very large for the proven behaviour.** 136 `export interface`
  declarations in `src` alone; ~8.8k LOC `src`, ~10.3k `integrations`, ~6.5k `test`; 34 docs.
  Multiple full backends (`DurabilityProvider` × 5, `WorldStore` × 3, `RuntimeStateStore` × 3,
  `BlobStore` × 3, three rate-limit/tenant policies) plus chaos wrappers and versioned tests
  (`v03`, `v04`, `v08`, `v09`) from earlier iterations.
- **SOLID — real duplication in the core idea.** There are two durable-turn implementations:
  `src/runtime/durable-turn.ts` (`runDurableTurn` unused) and
  `integrations/temporal/src/workflows.ts` (the one exercised). Likewise the runtime's
  `DurabilityProvider` abstraction is bypassed by its only real Temporal consumer. The central
  "durable runtime" abstraction is not the path the durable integration uses.
- **SOLID — the center of gravity is off `main`.** `main:src/gym/` is `scoring.ts` only. The gym
  runner that actually drives agents (`attempt`, `tools`, `turn`, `task`, `checkpoint`, `harvest`)
  exists only on `gym-runner`/`signal-swarm`; `origin/gym-runner` is behind the local tip and still
  contains `isolated-score.ts`, which the local branch removed. The flagship capability is not in
  the released tree, and the published branch is stale/diverged.
- **LIKELY — the layers that "seem necessary" rather than demanded:** the effect-policy gate with
  an approval channel nobody configures; the `DelegatedAgent` supervisor in `src` distinct from the
  session supervisor in `integrations`; the Temporal durability adapter; the transactional turn.
  Each is individually defensible; collectively they are the "complexity faster than it earns it"
  answer.
- **SPECULATIVE — `signal-swarm` (roadmap 5b) is a second arm-comparison harness** that will likely
  re-create the gym's scaffold (two arms, fault matrix, scoring) for a different signal source.
  Watch for a second parallel harness rather than a reuse of the first.

## 3. What is the biggest risk nobody is currently looking at?

**The project treats "untrusted execution" as a property of the gVisor rung, but model-controlled
code and data execute outside it by default on more than one path — and attention is currently on
one path only (the scorer).** (LIKELY, strongly evidenced.)

- The scorer isolation gap is now a known-open item and under active fix. But the agent path is
  worse and not in the queue: with the `local` runner (used by the P2 fault matrix and the
  dry-run), model-authored `he.js` runs on the host as `tiny`, with no permission model, and I read
  the held-out vectors from it during the attempt (previous round). The docs' security model does
  not mention a "local runner" as an untrusted context at all.
- The structural point is not "fix the local runner"; it is that **there is no single enforced
  boundary for agent-controlled execution**, so every isolation claim inherits the weakest path
  it happens to run on. The fix being built for the scoring worker will not cover the agent path.
  A model that can read the held-out cases and reach the host makes the gym's numbers
  uninterpretable regardless of how good the scorer becomes.
- **SOLID sub-point:** the sandbox agent path cannot currently run the task (`exit 127`), so
  "the agent works inside gVisor" is a claim about a path that does not execute. The only
  functioning agent path is the unisolated one.

**Second-biggest (LIKELY): the flagship evidence is branch-local and thin.** One repo (`he`), one
planted bug, mostly one code model; the matrix used the local runner; the durability signal is
mostly the SIGKILL/worker-restart rows on a single task. The project's headline—"durable agent
runtime"—rests on unmerged, not-yet-working code.

**SPECULATIVE:** the inference gateway's shared continuation/tenant/route state under multiple
replicas. The Postgres *lease/fencing* path is proven under 32 workers in CI; the gateway's
continuation store is not shown under replica concurrency, and it is the piece most likely to
break in a real deployment.

## 4. Is this worth building at all?

**A defensible split answer: keep the differentiated third, drop or subsume the duplicative
two-thirds.** (LIKELY.)

- **Genuinely not Temporal, and worth having (SOLID that it exists; LIKELY that it is valuable):**
  the **execution-rung abstraction** with per-effect escalation (synthetic ↔ gVisor) and the
  differential parity harness that keeps the cheap rung honest — Temporal has no notion of this.
  The **inference gateway** (OpenAI-compatible surface, profile routing with failover/cooldown/
  affinity, continuation store, lanes/tenant policy) is a modest but real delta over calling
  LiteLLM/OpenRouter directly. The **gym** (objective pass/fail, held-out vectors, anti-cheat,
  durability control arm) is the one genuinely novel idea in the repo.
- **Duplicative of Temporal (SOLID):** leases, fencing tokens, mailbox, consumer cursors, world
  CAS, effect receipts, recovery — this is the largest mass of code, and Temporal already provides
  durable execution, retries, signals, timers, cancellation and query. Worse, when the project
  *does* use Temporal it does **not** go through its own `DurabilityProvider` adapter, so the
  abstraction is not buying the composability it claims.
- **The uncomfortable conclusion:** as "a durable agent runtime", the rational build is to use
  Temporal's primitives and keep only the rung + gateway. As "an objective evaluation harness for
  agents that exercises durability", the gym is the point and the runtime is scaffolding — but the
  gym is the part that is least finished and whose agent execution is unisolated. Continuing is
  defensible only if the gym (or the rung/gateway) is the actual goal; continuing to grow the
  control plane is not.

## 5. If you had to cut half

Cut, with cuts that are SOLID unused or superseded:
`src/policy/effect-policy.ts`, `src/control-plane/effect-reconciler.ts`,
`src/orchestration/supervisor.ts`, `src/runtime/durable-turn.ts`, `src/runtime/transactional-turn.ts`,
`src/durability/temporal-adapter.ts`; the `AgentRunner`/`CommandCoordinator` if they survive only in
versioned tests; one of the parallel durability stacks; the chaos wrappers if unmaintained; the
versioned `v0x` tests and `docs/history/` moved off-tree.

What is left is the project's real identity (LIKELY): **an execution-rung + inference-gateway +
gym**, with a single Postgres-backed durability story where durability is actually needed. That is
a coherent, smaller, more honest system than the one described in `README.md`.

## 6. Quality of the evidence overall

- **SOLID / load-bearing:** the root and Temporal unit suites; **live Postgres concurrency and
  fencing in CI on every push** (`postgres-live.yml`, real postgres:16, `SYNTH_POSTGRES_WORKERS=32`);
  the git-transport tree-hash proof; the lane-gateway live proof; the blob-store tests; the scorer
  attack/regression tests. The skip contract (exit 2, never a pass) is implemented in
  `scripts/live-proofs.mjs` and is honest.
- **SOLID / thin where it matters:** the gVisor and Pi E2E proofs are `workflow_dispatch` /
  self-hosted / weekly, so they are not enforced per push and can rot; the gym's matrix came from
  the unisolated local runner; the corpus is 8 items (the doc says so); OpenRouter limits are
  unmeasured and labelled.
- **The pattern (LIKELY):** evidence is thick exactly where it was cheap to instrument in-process
  (scorer forgeries, patch-path fuzz, unit suites) and thin where the project's value is claimed
  (does an agent solve the task in the intended sandbox? does the runtime beat a plain loop across
  several tasks and models? does the gateway hold under replicas?). The seven review rounds found
  real defects precisely in claims that had been "signed off" by reading tests — i.e. where an
  adversarial probe did not yet exist. The strongest single asset in this repo is the adversarial
  review process, and it lives in `/tmp/opencode`, not in the repo, so it will not survive a
  reboot.

## Confidence summary

- **SOLID:** README/test-count and release-status drift; dead (unwired) modules and the
  Temporal adapter; two parallel durable-turn implementations; the flagship gym not on `main`;
  the agent path runs on the host under the local runner and reads the held-out vectors; the
  sandbox agent path exits 127; Postgres concurrency is CI-enforced, gVisor/Pi are not.
- **LIKELY:** the "aspirational docs vs partial wiring" pattern; the biggest risk being the
  absence of one enforced untrusted-execution boundary; the durability control plane being the
  duplicative mass and the rung/gateway/gym the real delta; the honest identity being a smaller
  eval+rung+gateway system.
- **SPECULATIVE:** signal-swarm becoming a second parallel harness; gateway continuation state
  being the operational weak point under replicas; the review process being the most valuable
  durable asset if it were moved into the repo.

---

# Second pass — additional evidence, and the same six questions tightened

## 1a. More doc-vs-code gaps (SOLID unless marked)

- **The distributed control plane is not deployable from the repo.** `deploy/` has Postgres
  migrations, a docker-compose, an executor `Dockerfile`, namespaces, RBAC and a `RuntimeClass` —
  but no `Deployment`/`StatefulSet`/`Rollout` for the control plane anywhere (`grep -rln "kind:
  (Deployment|Rollout|StatefulSet)" deploy` → nothing). `README.md:11` describes "multiple
  control-plane replicas operat[ing] against the same durable backend"; the repo ships no workload
  to run one replica of that control plane.
- **The inference gateway is the only server in `src`** (`grep -rln "createServer|listen(" src` →
  `inference/gateway/server.ts`). The runtime is a library barrel assembled by examples, scripts
  and tests; there is no product assembly. Not necessarily wrong for an infrastructure library,
  but it means "the runtime" has no deployable form.
- **`litellmProfile` is a live-proof demonstration, not a wired default.** Its only non-test
  consumers are `scripts/litellm-failover-live.ts` and `scripts/live-proofs.mjs`; the gateway
  server does not construct one. The CHANGELOG phrase "a LiteLLM profile behind the router" is
  true of the proof, not of the gateway as shipped.
- **The blob access model is implemented but unwired.** `GuardedBlobStore` and the tenant policies
  appear only in `src/artifacts/blob-store.ts` and `test/blob-access.test.ts`; no runtime path
  constructs them, so "across tenants `GuardedBlobStore` + `TenantBlobPolicy` enforce isolation"
  (`docs/KNOWN-OPEN.md:14`) is a library capability with no caller.
- **`SharedTenantRateLimitPolicy` and `PostgresDistributedControlStore` are exercised only by
  tests / the Postgres integration harness** (`test/postgres.test.ts`, `test/v08.test.ts`,
  `integrations/postgres/node-pg.ts`), not by the default runtime wiring. The shared, multi-replica
  behaviour the README centres on is demonstrated in a harness, not the assembled system.

*Pattern (LIKELY):* the repo repeatedly implements a capability to a testable shape and then does
not put it on the default path. The docs read as if the test/harness wiring were the product. This
is the same mechanism behind the isolation claim and the "unforgeable" scorer.

## 2a. Code mass vs proven value (SOLID arithmetic)

`src` LOC by area: `execution` 1814, `inference` 1414, `workspace` 1138, `runtime` 861,
`postgres` 760, `durability` 625, `gym` 489, `control-plane` 370, `artifacts` 366, `world` 284,
`chaos` 243, `orchestration` 98, `policy` 65, `adapters` 36.

- The durability/ownership/world machinery (`durability` + `postgres` + `control-plane` + `world`
  + `chaos` ≈ **2282 LOC**) is larger than the whole gym (489) and comparable to the entire
  execution+rung layer. That is the mass most duplicative of Temporal.
- The genuinely differentiated mass (`execution` + `workspace` + `inference` + `gym` ≈ **4855 LOC**)
  is where the value is — and it is the part with the least live, committed proof.
- `policy` (65 LOC, zero consumers) and `orchestration` (98 LOC, barrel-only) are the clearest
  "exists because it seemed necessary" units.

## 3a. The structural risk, restated with the operational evidence

- **SOLID:** the only deployable workloads in `deploy/` are the executor image and Postgres; the
  control plane has no manifest; the supervisor is not deployed (`deploy/` has nothing for it, and
  `docs/KNOWN-OPEN`/ROADMAP both say so). So "durable, distributed agent runtime" is, at this
  moment, a library plus hand-run drivers plus CI contracts — not an operated system.
- **LIKELY:** this is the risk nobody is pricing: the project's verification strategy (unit suites
  + skip-honest live proofs + adversarial review) is strong, but there is no operated deployment to
  accumulate the failures that matter (rolling upgrades, replica skew, continuation growth, real
  load). The gVisor and Pi proofs being manual/self-hosted means the two most environment-sensitive
  claims are the least continuously checked.
- **SPECULATIVE:** if and when it *is* operated, the first failures will be in shared mutable
  state (gateway continuation/route-health, world CAS under conflicting writers), not in the
  fencing primitives that are already well tested.

## 4a. Worth-building answer, made concrete

The repo's own file split argues for the answer: **two-thirds of `src` is the durable-control-plane
idea that Temporal already provides, and the third that is unique (rungs, gateway, gym) is the
least finished.** A rational continuation either (a) commits to Temporal as the durability engine
and deletes the parallel one, keeping rung+gateway+gym, or (b) commits to being an evaluation
harness (the gym) and treats the runtime as a test fixture. What is not defensible is growing both.
(LIKELY.)

## 5a. What the cut reveals (LIKELY, from SOLID unused-evidence)

Removing the zero-consumer modules (`policy`, `orchestration`, `durability/temporal-adapter`,
`runtime/durable-turn`, `runtime/transactional-turn`, versioned `v0x` tests) and one redundant
durability stack leaves a project that is honestly: **the execution rung + parity harness, the
inference gateway, and the gym** — with Postgres-backed leases as the one durability story where
the gym needs it. That identity is small enough to finish and operate.

## 6a. Evidence ledger, per claim (SOLID)

| claim | enforced how | verdict |
|---|---|---|
| root unit suite | CI `core.yml` on every push (`main`, 225 tests) | strong |
| Temporal integration suite | CI `core.yml` (46→49 tests) | strong |
| Postgres concurrency + fencing | CI `postgres-live.yml`, real postgres:16, 32 workers, every push | strong |
| git-transport tree hash | test + manual live proof | medium |
| lane gateway, LiteLLM failover | unit + manual live proof | medium |
| gVisor pod-kill | `workflow_dispatch` self-hosted only | weak (not per push) |
| Pi E2E | `workflow_dispatch` + weekly | weak (not per push) |
| gym scorer anti-cheat | branch tests; not on `main`'s CI | medium |
| gym agent-in-gVisor success | broken on the sandbox path (`exit 127`); matrix used local runner | **absent** |
| corpus quality | 8 items, self-labelled, documented as a smoke test | weak (honestly labelled) |

## Consolidated ranking

- **SOLID:** README/status and test-count drift; control plane not deployable (no workload
  manifest); gym runner absent from `main`; agent path runs model code on the host and reads the
  held-out vectors; sandbox agent path exits 127; zero-consumer modules and the dead Temporal
  adapter; code-mass skew toward the Temporal-duplicative third; Postgres CI-enforced, gVisor/Pi
  manual.
- **LIKELY:** "implement-then-don't-wire" as the organising habit; no operated system means the
  real failure modes are untested; the honest identity is a smaller eval+rung+gateway; the durable
  control plane is the cut.
- **SPECULATIVE:** signal-swarm as a second parallel harness; gateway/world shared-state as the
  first operational failure; moving the review process into the repo as the highest-leverage
  single change.
