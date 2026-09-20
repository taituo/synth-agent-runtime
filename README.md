# Synth Agent Runtime

**Infrastructure for running AI agents as durable, distributed workloads.**

Synth Agent Runtime is a runtime and control plane for long-running AI agents. It turns an agent from a process-bound chat session into a durable entity with its own state, lifecycle, mailbox, execution environment, recovery semantics, and ownership rules.

The runtime is designed for agents that may run unattended for minutes, hours, or longer; move between workers; survive process and machine failures; receive steering while they are already running; spawn or coordinate other agents; and eventually act on external systems. The agent itself can remain relatively simple. The runtime is responsible for making its execution reliable.

At the center of the design is a separation between **agent reasoning, durable state, and physical execution**. An agent can work against a fast in-memory workspace, a persistent project environment, or an isolated Kubernetes/gVisor sandbox without changing the higher-level agent model. Expensive or consequential operations can be pushed behind explicit execution and effect boundaries rather than being implicit side effects of an LLM conversation.

For distributed deployments, Synth provides durable agent state, mailboxes, revisions, leases, fencing tokens, command and effect coordination, crash recovery, and continuation state. Multiple control-plane replicas can operate against the same durable backend while stale workers are prevented from publishing state after ownership has moved elsewhere. PostgreSQL is the primary distributed persistence implementation, with in-memory, JSON-file, and Temporal-oriented adapters also included.

The runtime also includes an inference layer with OpenAI-compatible Chat Completions and Responses endpoints, streaming and tool-call support, continuation handling, routing, and provider abstraction. This allows agent execution to remain independent of a particular model provider or client surface.

Synth is **not an agent framework, prompt library, or a new model SDK**. Existing agent harnesses can sit on top of it. Pi, OpenCode-style clients, supervisors, workflow systems, or custom agents can use the runtime while Synth handles the less visible systems problems underneath them: ownership, persistence, isolation, recovery, concurrency, and safe interaction with the outside world.

The broader goal is to make agents behave more like normal distributed workloads: cheap to create, safe to interrupt, recoverable after failure, movable between execution environments, and able to continue working independently of the client that started them.

**Current release: `1.0.0-rc.1`.** The release candidate has been exercised against real PostgreSQL concurrency, a pinned Pi integration, Kubernetes with gVisor isolation, and a live external inference provider. Remaining work toward `1.0.0` is primarily operational hardening and sustained production-shape testing rather than a change to the core runtime model.

> **Release-candidate status.** This tree folds together the external v0.9
> audit fixes, the second review's cross-replica race fixes (atomic agent
> creation, mailbox-insertion-winner steering), a gateway abort-safety fix
> (a disconnecting client could crash the whole process), and a git
> ref/remote argument-injection fix (a workspace source ref could reach
> git's own option parser and run a program on the control-plane host). See
> `docs/SECOND-REVIEW.md` and `CHANGELOG.md` for the full history, including
> the known issues carried into this RC.


The central invariant:

```text
agent lease generation N
        │
        ▼
AgentRuntime.run(..., fence=N)
        │
        ▼
all durable agent-state transitions
        │
        ▼
PostgresPersistence.putAgentFenced()
        │
        ├─ owner matches lease row
        ├─ fencing token matches lease row
        ├─ lease is unexpired by PostgreSQL clock
        └─ stored generation never moves backwards
                │
                ├─ yes → COMMIT
                └─ no  → AGENT_FENCE_REJECTED
```

A stale worker can still exist as a process, but it cannot publish a later terminal `AgentSnapshot` after a newer lease generation has taken ownership.

## Agent-state fencing

### Hard agent-state fencing

`DurabilityProvider` now has an optional `putAgentFenced(snapshot, fence)` primitive. `LeasedAgentRunner` passes its active lease generation into `AgentRuntime.run()`, and state transitions use that proof on every durable agent-state write.

PostgreSQL validates the proof atomically against `synth_leases`. An unfenced update is allowed only while the agent row is still at fencing generation `0`; once fenced ownership has begun, legacy/unfenced updates are rejected with `AGENT_FENCE_REQUIRED`.

Local in-memory and JSON-file providers retain monotonic fenced generations for deterministic tests, while remaining usable as explicitly single-writer stores.

### Database-clock leases

PostgreSQL acquire, renew, release, and validity checks now derive time from `clock_timestamp()` inside PostgreSQL. The optional `now` parameter remains in the `LeaseStore` interface for deterministic in-memory tests, but the PostgreSQL implementation deliberately ignores worker-local time.

`LeaseStore.validateLease()` was added so higher-level commit logic does not compare PostgreSQL lease timestamps against `Date.now()` from another machine. `CommandCoordinator` now uses this authoritative validation before committing a command result.

### Live PostgreSQL proof extended

`integrations/postgres/concurrency.ts` now additionally checks:

```text
worker A clock = absurdly far in the past
worker B clock = absurdly far in the future
              │
              ▼
PostgreSQL clock remains authoritative
              │
              └─ B cannot steal A's unexpired lease
```

It also exercises generation-1 → generation-2 agent takeover and verifies that generation 1 cannot publish after generation 2 wins.

### Migration

`deploy/postgres/003_release_hardening.sql` adds `synth_agents.fencing_token`. Fresh installs also include the column through `POSTGRES_SCHEMA_SQL` and `001_runtime.sql`.

## Runtime layers

```text
Clients / OpenCode / Pi / Temporal / Supervisor
                    │
              Agent Runtime API
                    │
       ┌────────────┼───────────────┐
       │            │               │
 durable world   mailbox        inference
 CAS/revisions  seq + ACK   continuation/router
       │            │               │
       └────── distributed state ───┘
                    │
          lease + fencing token
                    │
        ┌───────────┴───────────┐
        │                       │
 AgentSnapshot writes      command commit
 hard-fenced in DB        authoritative lease
        │                       │
        └───────────┬───────────┘
                    │
             Execution Broker
          ┌─────────┴──────────┐
          │                    │
 synthetic RAM          physical sandbox
 MemoryWorkspace       Kubernetes / gVisor
```

### Agent and provider integrations

Synth Agent Runtime is independent of any particular agent harness or model provider.

It can be embedded underneath existing agents and coding harnesses, or used with custom workers that implement the runtime interfaces. Pi and OpenCode-related paths are included as integrations and have been used for end-to-end validation, but neither is required to use the runtime.

The inference gateway is provider-agnostic and exposes OpenAI-compatible Chat Completions and Responses interfaces. OpenCode Go is one provider path that has been tested against the runtime; other compatible or custom providers can be used instead.

Provider credentials are not bundled with Synth. Deployments supply and manage their own credentials and are responsible for complying with the terms and usage policies of the provider they choose.

## Tests executed for this artifact

```text
npm test  (root suite, Node >=22 required)
73 passed / 0 failed

npm run integrations:syntax
26 TypeScript integration files / 0 syntax diagnostics
4 shell files / syntax OK

integrations/opencode-http-gateway: npm test
1 passed / 0 failed  (abort-safety contract)
```

Also independently verified live, outside this repeatable suite (not
re-runnable without external infrastructure/credentials): real PostgreSQL
concurrency and fencing under 16 concurrent workers, a real pinned Pi
checkout E2E, a real Kubernetes + gVisor pod-kill, and a full
external-provider matrix (unknown-model/malformed/missing-model errors,
abort-survival, `previous_response_id` continuation, tool calls, 3-way
concurrency) against a live subscription-backed gateway. `npm run
live:proof` runs the same checks and reports **SKIP** (not PASS) for
whichever of these require infrastructure/credentials this environment
doesn't have.

## Start here

```bash
npm install
npm test
npm run release-hardening:contract
npm run live:proof
```

Start with `docs/MAP.md` for a plain-language map of the layers (model / provider /
gateway / backend / profile / execution rung / runtime / Pi) and what each is not.
For the design and failure rules, read:

1. `docs/ARCHITECTURE.md`
2. `docs/DISTRIBUTED.md`
3. `docs/HARDENING.md`
4. `docs/POSTGRES.md`
5. `docs/RECOVERY.md`
6. `docs/CODE-REVIEW.md`
7. `docs/RELEASE-GATE.md`

`docs/` holds every other design/subsystem doc (see `docs/README.md` for the
full index). All prior release documentation (the v0.1–v0.8 root Markdown
sets) is retained under `docs/history/` for archival reference.

## Release status

`1.0.0-rc.1` has closed every correctness/security issue found across two
independent audit passes, verified live: real PostgreSQL concurrency and
fencing, a real pinned Pi checkout E2E, a real Kubernetes + gVisor pod-kill,
and a full external-provider matrix (abort-survival, continuations, tool
calls, concurrency) against a live subscription-backed gateway — see
`docs/RELEASE-GATE.md` for the checklist and `CHANGELOG.md` for what was fixed
and what remains as a known, non-blocking gap (per-process-only rate
limiting, a chaos-testing coverage gap, and a few defense-in-depth items).
Remaining work before a GA `1.0.0` tag is operational hardening for a
fully-loaded production deployment: sustained soak/load testing, rolling
upgrade testing, distributed rate limiting, per-record task/artifact CAS,
and continuation retention/encryption policy.
