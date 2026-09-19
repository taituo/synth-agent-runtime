# Architecture v0.9

## v0.9 release-hardening delta

v0.9 adds a hard persistence boundary between a logical agent lease and every durable agent-state transition. `LeasedAgentRunner` passes an `AgentWriteFence` into `AgentRuntime.run()`. `PostgresPersistence.putAgentFenced()` accepts the mutation only when the matching `synth_leases` row has the same owner/token and is still unexpired according to PostgreSQL's clock. The `synth_agents.fencing_token` column prevents generation regression.

```text
lease generation 41 ──> runtime state write ──> DB validates 41 ──> commit
lease generation 42 ──> takeover
stale generation 41 ──> runtime state write ──> DB rejects      ──> stop
```

PostgreSQL lease time is also authoritative now: acquire, renew, release, and `validateLease()` use `clock_timestamp()`. Worker wall clocks are not part of the ownership decision.

v0.8 separates **logical durability** from **physical execution** and adds distributed ownership around the durable control plane.

```text
┌─────────────────────────────────────────────────────────────┐
│ Presentation                                                │
│ OpenCode / TUI / Desktop / voice / RPC / Temporal clients   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│ Agent Runtime                                               │
│ AgentInstance · Task · Relation · Message · Effect          │
│ attach / unattended / recover / fork / supervise            │
└───────────────┬──────────────────────┬──────────────────────┘
                │                      │
        ┌───────▼────────┐      ┌──────▼─────────────────┐
        │ Distributed CP │      │ Inference Gateway      │
        │ leases/fences  │      │ Responses + Chat       │
        │ mailbox/cursor │      │ route health/affinity  │
        │ CAS world      │      │ continuation state     │
        │ reconciliation │      │ tenant boundary        │
        └───────┬────────┘      └──────────┬─────────────┘
                │                          │
        ┌───────▼──────────────────────────▼─────────────┐
        │ Shared durability / PostgreSQL                 │
        └───────┬────────────────────────────────────────┘
                │
        ┌───────▼────────────────────────────────────────┐
        │ Workspace + Execution                          │
        │ MemoryWorkspace / lazy Git / snapshots         │
        │ synthetic → gVisor/Kubernetes → ProjectCell    │
        └────────────────────────────────────────────────┘
```

## Ownership is not identity

An `AgentInstance` can live for days. A lease only says which control-plane worker may currently drive a particular logical resource. A Pod is still a temporary execution resource, not the agent.

```text
AgentInstance ── durable for project lifetime
    │
    ├─ control-plane lease ── seconds
    │
    └─ executor lease ─────── seconds/minutes
```

## Fencing

Every successful re-acquisition of a resource gets a higher fencing token. A stale owner cannot renew or release a newer generation. Command records carry the fencing generation so stale command state cannot overwrite a committed newer generation.

```text
worker A: fence 41 ── expires
worker B: fence 42 ── owns resource
worker A: late write with 41 ── rejected by command state rules
```

`LeasedAgentRunner` is currently a cooperative run-ownership boundary. See `CODE-REVIEW.md` for the remaining requirement to fence every durable agent-state mutation atomically at the persistence layer.

## World concurrency

Projects use optimistic concurrency:

```text
read revision 8
   │
modify
   │
CAS(expected=8)
   ├─ success → revision 9
   └─ conflict → reload and retry/merge
```

Task and artifact records remain separately stored; project membership and accepted decisions are protected by project revision CAS.

## Mailbox semantics

The durable mailbox is append-only from the consumer's perspective. Delivery is at-least-once until ACK; processing becomes effectively-once only if the consumer's own work is idempotent/transactional.

The engine cursor advances only after a successful `AgentRuntime.run()`.

## Transaction boundary

The v0.7 semantic-exposure barrier remains unchanged:

```text
snapshot workspace
  → provider/tool attempt
  → buffer semantic output
  → persist semanticExposed=true
  → cross irreversible effect/publication boundary
  → terminal durable commit
```

A crash before semantic exposure may roll back. A crash after exposure requires reconciliation and must not be represented as a transparent replay.

## Inference state

`ProfileRouterBackend` no longer requires process-local health/affinity. A `RouterStateStore` can be PostgreSQL-backed. Continuation state for `previous_response_id` has the same shared-store shape.

Health state is shared per virtual-model/route. Affinity is additionally tenant + virtual-model + session scoped.

## Physical execution

Normal source manipulation can remain in `MemoryWorkspace`. Commands unsupported by the synthetic shell are escalated through the `ExecutionBroker` to physical resource classes. Warm sandbox reset is verified before reuse; a failed reset destroys the slot.

## Storage hierarchy

```text
PostgreSQL / durable store
├ agents/tasks/relations/events
├ command/turn/effect receipts
├ projects/artifacts
├ leases
├ mailbox + consumer cursors
├ Responses continuations
└ route health + affinity

RAM
├ live AgentEngine objects
├ MemoryWorkspace dirty overlays
├ local router caches
└ attached client listeners
```

RAM is acceleration, not canonical project truth.
