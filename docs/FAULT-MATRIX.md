# The fault matrix

One table, six dependencies, the same four questions, every cell an executed
measurement. This replaces the scattered fault proofs (one per harness) with a
single runner: `node scripts/fault-matrix.mjs`.

| question | meaning |
|---|---|
| **retried?** | after the dependency is removed, does the system attempt the work again? |
| **data lost?** | is durable state (workflow history, a committed row, a workspace write) destroyed by the removal? |
| **human needed?** | does the run end in a state that needs an operator, or recover on its own? |
| **side effect twice?** | can one logical action execute its external effect more than once? |

## Method

- **The fault is real.** A process is stopped, a port is denied, a pod is force
  deleted, a socket is pointed at a closed port. Nothing is simulated by a
  flag in the code under test.
- **A control runs first.** Each probe shows the dependency reachable/working
  under control conditions, then removes it. A negative assertion without a
  positive control measures a closed door, not a lock.
- **A skip is never a pass.** Probes exit `2` when their infrastructure is
  absent; the runner reports it as `skipped`.
- **Numbers, not conclusions.** The discriminating quantity (an attempt count,
  a status transition, a row count, a byte digest) is in every cell.
- **Unknown is allowed and labelled.** A cell that was not executed says
  **UNKNOWN** with the reason it was not.

Runner: `node scripts/fault-matrix.mjs [--out=DIR] [--only=a,b] [--json]`.
It shells out to the probes; the raw JSON of each is the artifact cited below.
**The artifacts cited in each section are committed under `docs/fault-matrix/`**
(the runner writes them to `--out`; the committed copies are the run of
2026-09-21).

Environment for this run (2026-09-21, `tiny`):

- Temporal `127.0.0.1:7243` (shared), plus dedicated servers on 7245/7246 for
  the restart probes.
- Postgres via `kubectl port-forward svc/postgres 5432:5432 -n synth-audit-pg`.
- k3s `gvisor` RuntimeClass; namespace `synth-audit-gvisor`.
- Executor image pinned by digest:
  `ghcr.io/taituo/synth-executor@sha256:fc59cec2b7a3733e9e50db1d5063669c60ec7add0d18a338b2a3f19a422c822f`.
- Model calls are replaced by a scripted OpenAI-compatible provider (zero quota).

## The matrix

| dependency removed | retried? | data lost? | human needed? | side effect twice? |
|---|---|---|---|---|
| **Temporal server** (persistent store) | **yes** — attempts `[1,2]` | **no** — status `RUNNING` after restart; result `recovered` | **no** — workflow finished on its own | **yes** — the activity body ran twice (at-least-once; dedup is the receipt store's job) |
| **Temporal server** (this environment: `7243`, no `--db-filename`) | **no** | **yes** — `WorkflowNotFoundError` after restart | **yes** — the run is gone | n/a (the run is gone) |
| **Postgres** (port 5432 denied) | **no** — `ECONNREFUSED` in 1 ms | **no** — control row still readable after the port returned | **UNKNOWN** — no production caller of `PostgresPersistence`; nothing on the durable path to measure | **no** — `putAgent` upsert, `rowsForId=1` |
| **model gateway / provider** | **yes** for refused/502/hang/429 (attempts `3/2/2/3`); **no** for 400 (1) | n/a — the turn boundary holds no durable state | **no** for transient (park → `idle`); **yes** for a permanent 4xx (status `failed`, 1 activity call) | **yes at HTTP** (provider called again per attempt); **no at the effect layer** (committed effects deduped) |
| **Kubernetes API** (closed port) | **no** — one `kubectl` per create, both failed once | **no** — workspace sentinel intact, 0 new pods | **UNKNOWN** — workflow-level retry over a dead API not measured | **no** — 0 pods created while unreachable |
| **sandbox pod** (force-deleted mid-exec) | **no** — one failed exec, surfaced as an error | **yes** — the in-flight write did not sync back | **UNKNOWN** — workflow-level reconciliation not measured | **no** for a committed effect — `started` is surfaced as uncertain, not replayed |
| **worker** (SIGKILL mid-turn) | **yes** — attempts `[1,1,2]`, `hangCalls=2` | **no** — `committedCalls=1` | **no** — final status `idle` | **no** for a committed effect — `committedCalls=1`; the in-flight turn's body does run a second time |

## Per-dependency evidence

### 1. Temporal server

Probe: `integrations/temporal/fault-temporal-server.ts` — starts a Temporal dev
server, runs `restartProbeWorkflow`, waits until the activity's first attempt is
in flight, **stops the server**, restarts it with the same store, and observes.

**Persistent (`--db-filename`)** — artifact `temporal-persistent.json`:

```json
{ "statusAfterRestart": "RUNNING", "attempts": [1, 2], "result": "recovered",
  "questions": { "retried": true, "dataLost": false, "humanNeeded": false, "sideEffectTwice": true } }
```

The workflow survived the process death, the in-flight activity was retried on
the restarted server, and no operator touched it. `sideEffectTwice: true` is the
honest answer: Temporal is at-least-once, so the activity body executed twice;
exactly-once is provided above it by the effect-receipt store (see §7).

**The deployed server is the in-memory case.** The shared server on `7243` was
started as `temporal server start-dev --headless --port 7243` with no
`--db-filename`; the CLI says *"By default, Workflow Executions are lost when the
server process dies."* Running the same probe without persistence —
artifact `temporal-inmemory.json`:

```json
{ "statusAfterRestart": "ERROR(WorkflowNotFoundError)", "ok": true,
  "questions": { "retried": false, "dataLost": true, "humanNeeded": true } }
```

This is the environment's actual Temporal: **a restart loses every run.** The
persistent arm shows the system is capable of surviving a Temporal restart; the
in-memory arm is what a restart of `7243` would do today. (See `docs/RECOVERY.md`
and `BRINGUP-PLAN.md` §B2 for the persistent-server decision.)

### 2. Postgres

Probe: `integrations/postgres/fault-postgres.ts` — owns a real
`kubectl port-forward svc/postgres 5432:5432`, writes and reads an agent through
it (control), **SIGKILLs the port-forward** (the port is denied), retries the
write, then restores the port.

Artifact `postgres-deny-port.json`:

```json
{ "control": { "wroteAndRead": true, "rowsForId": 1 },
  "portClosed": true,
  "fault": { "failedClosed": true, "error": "connect ECONNREFUSED 127.0.0.1:5432", "ms": 1 },
  "dataSurvivedOutage": true,
  "questions": { "retried": false, "dataLost": false, "humanNeeded": null, "sideEffectTwice": false } }
```

The store fails closed and fast, the write before the outage survived, and the
upsert is idempotent (`rowsForId=1` for two writes).

**humanNeeded is UNKNOWN, and why.** `PostgresPersistence` has no production
caller; the default `durableAgentWorkflow` path keeps effect receipts in Temporal
activity state. Call-path evidence (`docs/fault-matrix/callpaths.txt`):

```
$ grep -rn "PostgresPersistence\|openPostgresPersistence" src integrations --include=*.ts | grep -v /dist/ | grep -v node_modules | grep -v test/
src/postgres/persistence.ts:26:export class PostgresPersistence ...
integrations/postgres/{smoke,concurrency,node-pg,fault-postgres}.ts ...
```

The only non-test callers are the Postgres integration proofs. Removing Postgres
does not affect a default run because a default run never touches it. Whether an
operator is needed *if Postgres is wired in* was not measured (there is no wired
path to measure) — hence UNKNOWN, not a guess.

### 3. Model gateway / provider

Probe: `integrations/temporal/fault-gateway.ts` — a scripted OpenAI-compatible
provider (zero quota) behind real HTTP faults. Artifact `gateway-faults.json`:

| scenario | attempts | provider calls | outcome |
|---|---|---|---|
| connection refused | 3 | 0 | errored after retries |
| HTTP 502 on first | 2 | 1 | recovered |
| hung request, 1.5 s timeout | 2 | 1 | recovered |
| HTTP 429 + `Retry-After: 1` | 3 | 1 | recovered |
| HTTP 400 | 1 | 1 | errored, **not retried** |

Transient faults are retried with bounded backoff; a 4xx is not retried. The
workflow-level answer to *human needed* is measured by the park proofs against
`7243`:

- `gateway-park-retry-hint.json`: 4 activity calls, park gap 2055 ms honouring a
  2000 ms `Retry-After`, final status `idle` — **no human**.
- `gateway-park-quota.json`: `parkedLastError = "QUOTA_EXHAUSTED:..."`, final
  status `idle` — **no human**.
- `gateway-fatal-4xx.json` (`fault-gateway-fatal.ts`): a non-retryable 4xx →
  status `failed`, `activityCalls=1`, not parked — **human needed**.

Data-lost is **n/a**: a turn at this boundary holds no durable state. Side
effect twice: at the HTTP layer the provider is called again on each attempt
(the `attempts`/`providerCalls` columns); at the effect layer a committed effect
is deduped by `effect.id` (§7).

`integrations/gym/p2-faults.ts` is the existing system-level harness that runs
the plain and durable gym arms through one provider fault and reports whether the
arms are differentiated (`docs/GYM-P2-RESULTS.md`). It is not duplicated here and
not re-run for this matrix: it needs a full gym task, a worker and a scored
sandbox run per arm, and its provider must answer a multi-turn model
conversation. The turn-level probe above measures the retry policy directly at
zero quota, and the park proofs measure the workflow-level outcome; p2-faults
remains the harness for the end-to-end durability comparison.

### 4. Kubernetes API

Probe: `integrations/kubernetes/fault-k8s-api.ts`. Control: `kubectl get ns
synth-audit-gvisor` succeeds. Fault: `KUBECONFIG` points at a closed port
`https://127.0.0.1:59998`, then `KubectlSandboxBackend.create` is called twice.
Artifact `k8s-api-unreachable.json`:

```json
{ "control": { "reachable": true },
  "attempts": [ { "ms": 116, "ok": false }, { "ms": 0, "ok": false } ],
  "podsBeforeFault": 3, "podsAfterFault": 3,
  "workspaceSentinelIntact": true,
  "questions": { "retried": false, "dataLost": false, "humanNeeded": null, "sideEffectTwice": false } }
```

`kubectl` is a one-shot process and does not retry a refused connection; the
error is surfaced. The workspace sentinel is intact and no pod was created, so
there is no side effect to duplicate. `humanNeeded` is **UNKNOWN**: no Temporal
activity wraps the create in this probe, so the workflow's retry/reconciliation
behaviour during an API outage was not executed. The residual risk — a create
whose success response is lost and is retried — was not measured and is not
claimed either way (pod names are generated per call, so a retry would create a
*different* pod).

### 5. Sandbox pod

Probe: `integrations/kubernetes/fault-sandbox-pod.ts`. Control: exec
`cat /workspace/seed.txt` returns `hello-from-memory` (materialize works). Fault:
exec a command that writes `/workspace/inflight.txt` then sleeps; force-delete the
pod at ~2 s. Artifact `sandbox-killed-mid-exec.json`:

```json
{ "control": { "ok": true, "stdout": "hello-from-memory" },
  "killed": { "ok": false, "error": "... pod does not exist" },
  "inflightWriteSyncedBack": false,
  "questions": { "retried": false, "dataLost": true, "humanNeeded": null, "sideEffectTwice": null } }
```

The executor surfaces the kill as one failed exec and does not retry it; the
in-flight write is not synced back (`dataLost: true`). The companion
`fault-rungs.ts` control set confirms the same path works when the pod lives:
`execSuccess` ok, `execWriteBack` ok, `execTimeout` → `EXECUTION_TIMEOUT`,
`execSigkill` → `NotFound`. Side effect twice is answered at the durable layer by
§7, not by the executor: the kill leaves no committed receipt, and a `started`
receipt is surfaced as uncertain rather than replayed.

### 6. Worker (SIGKILL mid-turn)

Reused proof: `integrations/temporal/durable-restart-worker.ts` (node 22 /
Temporal `7243`). Artifact `worker-sigkill.json`:

```json
{ "committedCalls": 1, "hangCalls": 2, "attempts": [1, 1, 2],
  "committedNotRerun": true, "hungTurnRetried": true, "finalStatus": "idle" }
```

The committed turn was not re-derived; the in-flight turn was retried
(`attempts [1,2]`) and the workflow drained with no human. This is the same
result recorded in `docs/RECOVERY.md` §3.

### 7. Side-effect dedup (cross-cutting)

Reused proof: `integrations/temporal/effect-receipt-live.ts` against `7243`.
Artifact `effect-receipt-dedup.json`:

```json
{ "attempts": [1, 2],
  "attempt2Seed": ["...:write_file:0:committed", "...:write_file:1:started"],
  "firstEffectExecutions": 1,
  "executions": ["...:write_file:0#1", "...:write_file:1#1"] }
```

A retried activity does not re-execute a committed effect (`firstEffectExecutions
= 1` across attempts `[1,2]`); an effect left `started` crosses the retry as
`started` (uncertain) and is **not** replayed. That is the mechanism behind
`sideEffectTwice: no` for the durable dependencies in the matrix.

## Reproduce

```sh
node scripts/fault-matrix.mjs --out=/tmp/fault-matrix
node scripts/fault-matrix.mjs --only=temporal-server,worker --json
```

It is wired into `scripts/live-proofs.mjs` as the `fault-matrix` proof
(`requires: temporal+k8s+gvisor`, 15 min budget); it skips when that
infrastructure is absent.

## What is still UNKNOWN

| cell | reason |
|---|---|
| Postgres · human needed | no production caller of `PostgresPersistence`; there is no wired workflow to measure |
| Kubernetes API · human needed | no Temporal activity wraps the create in the probe; outage retry/reconciliation not executed |
| sandbox pod · human needed | workflow-level reconciliation of an interrupted sandbox effect not executed |
| sandbox pod · side effect twice | executor-level only; the durable answer is `effect-receipt-dedup` |
| Temporal `7243` · side effect twice | n/a: the in-memory server loses the run before any retry |

No cell is inferred from a passing status alone; each cites an attempt count, a
status transition, a row count, or a byte-level workspace read.
