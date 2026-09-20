# Confining the scoring worker: plan for an OS-level boundary

Status: **REQUIRED, NOT BUILT.** The scoring worker is NOT isolated from the
host. Review round six enumerated six capability classes that escape the Node
permission model; measured on this host by `scripts/scorer-isolation-probe.mjs`
against the real worker (2026-09-20):

| class | measured |
|---|---|
| `node:sqlite` | **blocked** (explicit deny, `1a55a4c`) |
| TCP to temporal `:7243` | **REACHABLE** (`CONNECTED`) |
| TCP to postgres `:5432` | **REACHABLE** (`CONNECTED`) |
| unix socket bind outside the clone | **REACHABLE** (`BOUND`) |
| `node:test` executes an outside file | **UNCONFIRMED** by this payload (reviewer proved it with another) |
| `process.kill` the verifier (signal 0) | **REACHABLE** (`CAN-SIGNAL-VERIFIER`) |
| `os.userInfo` host metadata | **REACHABLE** (`tiny:1000`) |

So a gym run can reach local services (temporal, postgres) and mutate host state
independent of the verdict. The permission model covers fs, `dlopen`, wasi, heap
snapshots and process reports, which is why it looked like a boundary; it is a
guardrail, not one. Denying builtins one at a time has no finite end, so an
OS-level boundary is a **requirement**.

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

### A. Route the worker through the gVisor execution rung (recommended)

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

### C. Keep the guardrail model + builtin denies (interim only)

What is in place today. Acceptable only while it is documented as a guardrail and
the scorer never persists expected values, case data or secrets anywhere a path
from the worker can name. Not the durable answer.

## Staged plan

1. **Now (done):** `node:sqlite` deny, `FORGE 8`, and the guardrail wording in
   `src/gym/scoring.ts`, `CHANGELOG.md` and `docs/KNOWN-OPEN.md`.
2. **Next:** add option B as a CI-built artifact (static Landlock launcher) and
   make the scorer prefer it; probe for it and fall back with a recorded caveat.
3. **Or:** add option A behind the existing cluster env (`SYNTH_EXECUTOR_IMAGE`,
   `SYNTH_RUNTIME_CLASS`, `SYNTH_KUBERNETES_NAMESPACE`), skipping with exit 2 when
   unconfigured.
4. **Acceptance:** a regression that opens a host SQLite DB, and any future
   builtin escape, is blocked by the OS boundary rather than by a new builtin
   deny. The `FORGE 8` test then passes for a kernel reason, not a flag.

## Open question

Should the OS boundary be **mandatory** (refuse to score when neither Landlock
nor gVisor is available, as the scorer already refuses when there is no
permission model), or best-effort with a recorded caveat? Mandatory is safer and
consistent with the existing refuse-to-run stance; it costs the ability to score
on a bare host.
