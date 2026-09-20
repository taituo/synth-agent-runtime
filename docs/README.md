# Documentation index

Start with the root [`README.md`](../README.md) and [`CHANGELOG.md`](../CHANGELOG.md).
Everything below is design/subsystem detail, in rough reading order. Each entry
is labelled **current** or *historical*.

The runtime is Temporal-driven: `durableAgentWorkflow` → `runTurn` →
`GatewayAgentEngine`, with the execution rung and the Postgres stores. The
pre-consolidation design (a homegrown agent runtime and control plane) is
archived under [`history/`](history/); unwired modules are in
[`history/museum/`](history/museum/).

## Core design

- [`HARNESS.md`](HARNESS.md) — **current**: the Temporal graph harness (loops, fan-out/join, branches, child workflows).
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — **current**: the runtime layers (Temporal, the turn body, the execution rung, the Postgres stores).
- [`EXECUTION-PATHS.md`](EXECUTION-PATHS.md) — **current**: every loop/scheduler/driver marked PRODUCTION (Temporal) / CONTROL (labelled) / DEV.
- [`DISTRIBUTED.md`](DISTRIBUTED.md) — **current**: the Postgres store contracts (leases/fencing, effect receipts, mailbox, world CAS, shared inference state).
- [`MAP.md`](MAP.md) — plain-language map of the layers and what each is not.
- [`SPEC.md`](SPEC.md) — *historical*: v0.2 design spec; superseded by `ARCHITECTURE.md` and the root `README.md`.
- [`WORLD.md`](WORLD.md) — *historical*: the in-memory/JSON world implementations are quarantined; `src/world/types.ts` and the Postgres store remain.

## Hardening and review

- [`HARDENING.md`](HARDENING.md) — **current**: the security/correctness model (Temporal execution, store-level fencing, effect receipts).
- [`RECOVERY.md`](RECOVERY.md) — **current**: Temporal restart/replay recovery and effect-receipt uncertainty.
- [`RELEASE-GATE.md`](RELEASE-GATE.md) — **current**: checklist gating `1.0.0` GA.
- [`CHAOS.md`](CHAOS.md) — *historical*: the `src/chaos/*` harness is quarantined (no production caller).

## Infrastructure

- [`POSTGRES.md`](POSTGRES.md) — PostgreSQL durability/distributed-state backend.
- [`KUBERNETES.md`](KUBERNETES.md) — Kubernetes + gVisor execution backend design.
- [`KUBERNETES-RUN.md`](KUBERNETES-RUN.md) — real, executed run guide: install gVisor, wire it into k3s, prove isolation, run the kill contract.
- [`TEMPORAL.md`](TEMPORAL.md) — **current**: the Temporal runtime (workflow, signals/queries, retry/park semantics, redelivery rule).
- [`SESSION-SUPERVISOR.md`](SESSION-SUPERVISOR.md) — durable supervisor for interactive agent sessions (separate Temporal deployment).
- [`BLOB-STORE.md`](BLOB-STORE.md) — content-addressed store: access model (digest-as-capability, tenant isolation) and lifecycle.
- [`GIT-PUSH-CREDENTIALS.md`](GIT-PUSH-CREDENTIALS.md) — scoped, one-shot sandbox push grants for git-as-transport, and the residual risk.
- [`OBSERVABILITY.md`](OBSERVABILITY.md) — tracing.
- [`UPGRADE.md`](UPGRADE.md) — *historical*: a specific `v0.8 → v0.9` migration note, correct as-is for that transition.

## Inference gateway

- [`INFERENCE.md`](INFERENCE.md), [`RESPONSES.md`](RESPONSES.md), [`LIVE-CONTRACTS.md`](LIVE-CONTRACTS.md), [`LIVE-PROOF.md`](LIVE-PROOF.md) — gateway protocol, config-driven providers, contracts, live-proof harness.
- [`PI-E2E.md`](PI-E2E.md) — *historical*: Pi checkout end-to-end test notes (the Pi adapter is quarantined).

## Status and verification

- [`KNOWN-OPEN.md`](KNOWN-OPEN.md) — **current**: deliberately unfinished work, one line each on why it is open and what closing it needs.
- [`VERIFICATION.md`](VERIFICATION.md) — **current**: the verification standard, how to run the set (`npm run verify`), and the permanent regression test behind each demonstrated attack.
- [`VERIFICATION-LOG.md`](VERIFICATION-LOG.md) — failing-first evidence: per commit, the mutation applied, the failure it produced, and the restore.

## Other

- [`INTEGRATION.md`](INTEGRATION.md) — third-party integration notes.
- [`ROADMAP.md`](ROADMAP.md) — forward-looking plans.
- [`history/`](history/) — *fully historical archive*: prior-release Markdown sets (v0.1–v0.8); the point-in-time reviews (`CODE-REVIEW.md`, `SECOND-REVIEW.md`); the deleted transactional-turn and supervisor docs (`TRANSACTIONS.md`, `SUPER.md`); and the quarantined code under `history/museum/`. Not maintained and not reconciled with current status.
