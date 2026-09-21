# Confining the scoring worker: the OS-level boundary

Status: **BUILT for the scoring worker** (`src/gym/sandbox-worker.ts`, the
gVisor pod path). Review round six enumerated six capability classes that escape
the Node permission model; `scripts/scorer-isolation-probe.mjs` now runs each
payload through the real worker and checks for a **host effect**, not just a
worker diagnostic. Measured on this host (2026-09-20), before and after:

| class | host worker (before) | gVisor pod (after) |
|---|---|---|
| `node:sqlite` writes a host DB | blocked (explicit deny) / host file absent | **blocked** (host file absent) |
| TCP to temporal `:7243` | **REACHABLE** (`CONNECTED`) | **blocked** (`ECONNREFUSED`) |
| TCP to postgres `:5432` | refused (no service) | **blocked** (`ECONNREFUSED`) |
| unix socket bind at a host path | **REACHABLE** (socket on host) | **blocked** (`EACCES`, no host file) |
| `process.kill` the verifier (host PID) | **REACHABLE** (`CAN-SIGNAL-VERIFIER`) | **blocked** (`ESRCH`, separate PID namespace) |
| `os.userInfo` host metadata | **REACHABLE** (`tiny:1000`) | **blocked** (`synth:65532`) |

The host worker is confined by Node's permission model, which covers fs,
`dlopen`, wasi, heap snapshots and process reports — a guardrail, not a
boundary. Denying builtins one at a time has no finite end, so the boundary is
the OS: the worker now runs in the same Kubernetes + gVisor pod the execution
rung already trusts.

## How it works

`isolatedScoreGymPatch` clones the pinned base and applies the patch on the
trusted side (tampering and escaping-symlink checks unchanged). When a cluster
image is configured (`SYNTH_EXECUTOR_IMAGE`; optionally
`SYNTH_SCORER_NAMESPACE`, `SYNTH_RUNTIME_CLASS`, `SYNTH_KUBERNETES_CONTEXT`, or
an injected `IsolatedScoreOptions.sandbox`), the applied checkout is
materialized into a one-shot gVisor pod (no host mounts, no host `/tmp`, no
`.git`, no `node_modules`) and the worker runs there in batch mode:

```text
node worker.mjs requests.json results.json     # one-shot in the pod
```

`requests.json` carries only module/call/args — **never** an expected value —
and the verifier compares the returned values back on the trusted side. The
pod's network policy allows DNS egress only, and its network/PID namespaces are
its own, so it cannot reach Temporal/Postgres, signal the verifier, or read the
host. `SYNTH_SCORER_SANDBOX=0` forces the host path for local debugging;
`SYNTH_REQUIRE_ISOLATION=1` refuses (errored) when no boundary is configured.
The permission-model deny flags remain as defence in depth on the host path.

## One boundary, both execution paths (scope)

There must be a SINGLE enforced boundary for all agent-controlled execution —
the scoring worker AND the agent's own tool execution. Otherwise every isolation
claim inherits the weakest path it happens to run on.

- **the scoring worker**: now runs in the gVisor pod when configured; the host
  path remains only as a labelled, opt-out development mode.
- **the gym's `localEffectRunner`**: still runs agent tools on the host and is a
  labelled **control** arm (`role:"control"`, `isolation:"unisolated"`), refused
  for scored runs — the drivers pre-flight (`assertScoredRunnerAllowed`) and the
  activities (`assertRungAllowedForScored`, with the `scored` flag threaded from
  the workflow input) both decide via the same `scoredRungAllowed` predicate, so
  there is no second `scoredAllowed` flag to drift. It is not a production path:
  a scored run uses `runner:"sandbox"`, where the gym's tools execute in the pod
  through the same `SandboxWorkspaceExecutor` the runtime sandbox rung uses
  (including `workspace.replace`). The runtime turn's own `config.scored` guard
  covers any runtime caller that selects a rung.

A deployment that requires isolation sets `SYNTH_REQUIRE_ISOLATION=1`: the
scorer then runs in the pod, or refuses (`errored`, "untrusted context") when no
boundary is configured, rather than running agent code on the host. The gVisor
substrate is confirmed: a pod reports `uname 4.19.0-gvisor`.

## The problem

The gym scorer runs the agent's module in a worker child and confines it with
Node's permission model (`--permission --allow-fs-read=<work>`) plus an explicit
`node:sqlite` deny. The permission model is documented by Node as a **guardrail,
not a security boundary against in-process code**, and it does not gate every
builtin: `node:sqlite` reached and mutated host state regardless of the allowlist
(review round six, fixed in `1a55a4c`). The reviewer is enumerating other
builtins that escape the model, so denying them one at a time is a losing game.
The confinement must come from the OS, not from a builtin allowlist.

## What the boundary must guarantee

- The worker can read only the scoring work dir (the clone and its own script).
- It cannot reach host state anywhere else: other filesystems, other processes,
  the Temporal dev database, `/proc`, or a SQLite file.
- It cannot open a network socket to exfiltrate or fetch.
- The verifier holds the held-out vectors; the worker only ever reports raw
  values. (This part already holds and does not depend on the sandbox.)

## Measured feasibility on this host (2026-09-20)

Host: Linux 6.8.0, Node 22.20.0, no privileges.

| mechanism | result |
|---|---|
| `unshare -m` (mount namespace) | `EPERM` — needs `CAP_SYS_ADMIN` |
| `unshare -Urm` (user + mount) | `EPERM` writing `/proc/self/uid_map`; `apparmor_restrict_unprivileged_userns=1` |
| `bwrap` / `podman` / `docker` | not installed |
| Landlock | present: LSM list is `lockdown,capability,landlock,yama,apparmor`; kernel 6.8 supports it. No compiler (`gcc`/`cc`/`clang` absent) and no `landlock-restrict` binary; Node exposes no binding |
| `systemd-run --user` (transient service) | filesystem sandboxing applies (`ProtectSystem=strict` denied a `/etc` write; `ReadWritePaths` honoured) but **`PrivateNetwork=yes` does not** — a TCP connect to `127.0.0.1:7243` still succeeded. Unprivileged network namespaces need a user namespace, which is AppArmor-blocked. Not sufficient alone |
| k3s cluster | reachable: one Ready node (`kubectl get nodes`). A pod gives a real network + mount namespace; this is the available container boundary |
| `kubectl` + gVisor rung | `kubectl` present; `SYNTH_EXECUTOR_IMAGE`/`SYNTH_RUNTIME_CLASS` are the repo's existing sandbox path |

So a mount-namespace sandbox is not available locally without privileges, and a
Landlock launcher cannot be compiled here. Both remain viable with the right
provisioning.

## Options

### A. Route the worker through the gVisor execution rung (implemented)

The repo already trusts gVisor for agent tool execution. Run the scoring worker
as a one-shot pod in the same rung: mount only the work dir, no host `/tmp`, no
cluster network. Reuse `SyntheticExecutor`/`KubernetesExecutor` and the existing
image pinning. Requests go in on stdin, replies come back on the pod's stdout
(or an `exec` pipe); the verifier still holds the vectors.

- Pros: a real kernel/VM boundary the repo already operates; no new privileges.
- Cons: asynchronous and cluster-dependent; the scorer becomes infra-bound and
  must skip (exit 2) when the cluster is absent, like the other live rungs.

### B. Landlock launcher

A small static binary using Landlock (ABI v4 on kernel 6.8) restricts the
worker's filesystem to the work dir, then `exec`s node. Kernel-enforced,
unprivileged, no cluster.

- Pros: local, fast, no cluster; the correct tool for path-scoped fs limits.
- Cons: needs a build step and a CI-produced artifact (this host has no
  compiler); Linux-only; still need seccomp for network denial.

### C. The host worker + guardrail model (the fallback)

The path used when no cluster image is configured (or `SYNTH_SCORER_SANDBOX=0`).
Acceptable only while it is documented as a guardrail and the scorer never
persists expected values, case data or secrets anywhere a path from the worker
can name. Not the boundary.

## Staged plan

1. **Done:** `node:sqlite` deny, `FORGE 8`, and the guardrail wording.
1b. **Done — batch worker mode.** `WORKER_SOURCE` runs one-shot when given
   `<requests.json> <results.json>`: it reads only module/call/args (never
   expected values), evaluates, writes results, exits — so it can run under a
   one-shot `process.exec` in a pod instead of an interactive fd3 pipe.
1c. **Done — pod wiring (option A).** `src/gym/sandbox-worker.ts` materializes
   the applied checkout into a one-shot pod via `KubectlSandboxBackend` +
   `WorkspaceSynchronizer`, writes `worker.mjs` and the requests file, `exec`s
   the worker in batch mode, reads the results file and compares in the
   verifier. Network policy is the rung's DNS-only egress; only `/workspace` is
   mounted. Selected by `SYNTH_EXECUTOR_IMAGE` (or injected
   `IsolatedScoreOptions.sandbox`); `SYNTH_REQUIRE_ISOLATION=1` refuses when
   unconfigured; `SYNTH_SCORER_SANDBOX=0` forces the host path.
2. **Open — Landlock launcher (option B).** Useful for a bare host: a CI-built
   static Landlock launcher restricts the worker's filesystem without a cluster
   (still needs seccomp for network denial). Not built; the pod is the boundary.
3. **Met — one boundary for the agent's tool path too.** A scored gym run uses
   `runner:"sandbox"`, so the agent's `workspace.*` and `process.exec` effects run
   in the gVisor pod through the same `SandboxWorkspaceExecutor` as the runtime
   rung (including `workspace.replace`). `localEffectRunner` stays a labelled
   **control** arm and is refused for scored runs by the shared
   `assertRungAllowedForScored` (`scored` threaded from the workflow input).
4. **Acceptance (met for the scoring worker).** `node scripts/scorer-isolation-probe.mjs`
   is red on the host worker and green in the pod: every class is blocked by the
   OS boundary, and the golden fix still passes / a wrong fix still fails
   (`test/gym-real-task.test.ts` through the pod).

## Decision

The boundary is **mandatory when a deployment requires it**:
`SYNTH_REQUIRE_ISOLATION=1` runs the pod and refuses (`errored`) if none is
configured, rather than scoring on a bare host. Without that flag the scorer
uses the pod when `SYNTH_EXECUTOR_IMAGE` is set (the default for any cluster
deployment) and otherwise the host path, which is documented as a guardrail.
