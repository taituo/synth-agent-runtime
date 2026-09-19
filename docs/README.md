# Documentation index

Start with the root [`README.md`](../README.md) and [`CHANGELOG.md`](../CHANGELOG.md).
Everything below is design/subsystem detail, in rough reading order.

## Core design

- [`SPEC.md`](SPEC.md) — full behavioral specification.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — runtime layers and invariants.
- [`DISTRIBUTED.md`](DISTRIBUTED.md) — control-plane distribution model.
- [`WORLD.md`](WORLD.md), [`TRANSACTIONS.md`](TRANSACTIONS.md) — durable world state and transactional turns.
- [`SUPER.md`](SUPER.md) — supervisor/orchestration.

## Hardening and review

- [`HARDENING.md`](HARDENING.md) — agent-state fencing, lease model.
- [`RECOVERY.md`](RECOVERY.md) — crash/SIGKILL recovery.
- [`CHAOS.md`](CHAOS.md) — chaos-testing harness.
- [`CODE-REVIEW.md`](CODE-REVIEW.md) — prioritized findings from the backward code review.
- [`SECOND-REVIEW.md`](SECOND-REVIEW.md) — external-audit second-review findings (SR-P1/SR-P2).
- [`RELEASE-GATE.md`](RELEASE-GATE.md) — checklist gating `1.0.0` GA.

## Infrastructure

- [`POSTGRES.md`](POSTGRES.md) — PostgreSQL durability/distributed-state backend.
- [`KUBERNETES.md`](KUBERNETES.md) — Kubernetes + gVisor execution backend design.
- [`KUBERNETES-RUN.md`](KUBERNETES-RUN.md) — real, executed run guide: install gVisor, wire it into k3s, prove isolation, run the kill contract.
- [`TEMPORAL.md`](TEMPORAL.md) — Temporal durability adapter.
- [`OBSERVABILITY.md`](OBSERVABILITY.md) — tracing.
- [`UPGRADE.md`](UPGRADE.md) — upgrade notes.

## Inference gateway

- [`INFERENCE.md`](INFERENCE.md), [`RESPONSES.md`](RESPONSES.md), [`LIVE-CONTRACTS.md`](LIVE-CONTRACTS.md), [`LIVE-PROOF.md`](LIVE-PROOF.md) — gateway protocol, contracts, live-proof harness.
- [`PI-E2E.md`](PI-E2E.md) — Pi checkout end-to-end test notes.

## Other

- [`INTEGRATION.md`](INTEGRATION.md) — third-party integration notes.
- [`ROADMAP.md`](ROADMAP.md) — forward-looking plans.
- [`history/`](history/) — full archived Markdown sets from prior releases (v0.1–v0.8), kept for reference only; not maintained.
