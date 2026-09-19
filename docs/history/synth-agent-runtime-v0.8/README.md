# Synth Agent Runtime v0.8

v0.8 is the **distributed control-plane** release. It keeps the synthetic-workspace, transactional-turn, Kubernetes/gVisor, Postgres, Pi/OpenCode, Responses, chaos, and crash-recovery layers from v0.1–v0.7, then closes the largest multi-replica gaps found by the v0.7 backward code review.

The central invariant is now:

```text
logical agent / task / command
          │
          ▼
   durable shared state
          │
   ┌──────┴────────┐
   │               │
lease + fence    CAS revision
   │               │
   ▼               ▼
one active owner   no blind project overwrite
   │
   ├─ durable mailbox + ACK cursor
   ├─ effect reconciliation
   ├─ shared continuation state
   ├─ shared route health/affinity
   └─ resumable event sequence
```

A process, provider route, or executor can disappear without making the project model depend on that process's heap. v0.8 does **not** claim that every distributed failure is solved; the remaining hard boundaries are documented in `CODE-REVIEW.md`.

## What is implemented

### Distributed ownership

`LeaseStore` provides expiring ownership with monotonically increasing fencing tokens. `CommandCoordinator` uses a renewable lease and never blindly replays an abandoned `started` command. Reconciliation must explicitly classify it as committed, failed, retryable, or still unknown. Reconciliation results are published under the currently held fencing generation.

`LeasedAgentRunner` serializes a logical agent run across cooperative control-plane replicas and aborts the local run if renewal is lost.

### Durable mailbox

Messages can live outside `AgentSnapshot` in a `MailboxStore`:

```text
producer → append(agent, message-id) → seq
                                  │
engine consumer ← read after ACK ─┘
      │
      └─ ACK only after successful run
```

Message IDs are idempotent, cursors are monotonic, and an ACK is clamped to a sequence that actually exists.

### Project CAS

`ProjectSpec` now carries `revision`. `compareAndSwapProject()` updates only the expected revision and increments it on success. The in-memory, JSON-file, and PostgreSQL world implementations use the same semantic. Blind `putProject()` cannot overwrite an equal or newer revision.

### Uncertain-effect reconciliation

`EffectReconciler` inspects a durable `started` receipt through effect-specific probes. It may mark the receipt committed or failed after observing the external world, but it never replays the original side effect merely because the outcome is unknown.

### Shared inference state

The inference layer gained shared stores for:

- `previous_response_id` continuation data
- provider/route health and cooldown state
- sticky session affinity

Affinity keys are tenant-scoped. A continuation owned by one tenant is not returned to another tenant or to an anonymous caller.

### Gateway tenant boundary

The HTTP gateway can require authentication and apply model ACL/rate policies before dispatch. Authenticated identity is propagated downstream as `x-synth-tenant` and `x-synth-subject`. `/v1/models` is authenticated and filtered when authentication is configured.

The included `StaticBearerAuthenticator` and in-memory rate limiter are reference implementations, not production identity/rate-limit infrastructure.

### PostgreSQL distributed store

`PostgresDistributedControlStore` implements leases, mailbox/cursors, continuation state, route health, and affinity. `deploy/postgres/002_distributed_control_plane.sql` adds the required tables. Lease release preserves the row and fencing history instead of deleting it.

The live Postgres contention scenario checks that concurrent workers produce one winner for command claim, effect claim, lease ownership, and project CAS.

### Resumable runtime events

Durability providers can expose ordered `{seq,event}` reads and retention pruning. Consumers can resume after a known sequence instead of replaying every historical event.

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
         leases + fencing tokens
                    │
             Execution Broker
          ┌─────────┴──────────┐
          │                    │
 synthetic RAM          physical sandbox
 MemoryWorkspace       Kubernetes / gVisor
          │                    │
          └──── artifact/commit┘
```

## Tests executed for this artifact

```text
npm test
62 passed / 0 failed

npm run distributed:contract
13 passed / 0 failed

npm run process-crash:contract
1 passed / 0 failed

npm run responses:contract
6 passed / 0 failed

npm run integrations:syntax
25 TypeScript integration files / 0 syntax diagnostics
4 shell files / syntax OK

npm run live:proof
PASS core build + contracts
PASS integration syntax
PASS real SIGKILL recovery contract
PASS Responses contracts
SKIP live PostgreSQL (SYNTH_POSTGRES_URL not set)
SKIP Pi checkout E2E (PI_REPO not set)
SKIP live Kubernetes Pod kill (SYNTH_K8S_LIVE != 1)
SKIP external gateway probe (SYNTH_GATEWAY_URL not set)
```

External-system tests are intentionally reported as **SKIP**, not PASS, when their infrastructure or credentials are absent.

## Start here

```bash
npm install
npm test
npm run distributed:contract
npm run live:proof
```

For the architecture and failure rules read, in order:

1. `ARCHITECTURE.md`
2. `DISTRIBUTED.md`
3. `TRANSACTIONS.md`
4. `RECOVERY.md`
5. `POSTGRES.md`
6. `CODE-REVIEW.md`

All prior release documentation is retained under `docs/history/`. `docs/MARKDOWN-MANIFEST.md` lists every Markdown file in the package.

## Production boundary

v0.8 is a hardened prototype/reference implementation. Before treating it as a production multi-tenant control plane, address the remaining findings in `CODE-REVIEW.md`, especially hard fencing of every stale agent mutation, database-clock lease semantics, distributed rate limiting/audit, per-entity world revisions, and operational policies for continuation/event retention.
