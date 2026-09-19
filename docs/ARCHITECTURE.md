# Architecture

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

## Agent identity

An `AgentInstance` can live for days. Its identity is created exactly once: `DurabilityProvider.createAgent(snapshot)` is an atomic identity-creation primitive, not a read-then-write preflight check. `AgentRuntime.spawn()` treats a `false`/non-insertion result as `AGENT_ALREADY_EXISTS`, so two concurrent `spawn()` calls for the same ID can never both succeed, whether they land on one runtime or on two runtimes sharing one durability provider. See `docs/DISTRIBUTED.md` for the exact per-provider implementation.

## Ownership and fencing

A lease only says which control-plane worker may currently drive a particular logical resource. Ownership is not identity: a Pod is a temporary execution resource, an `AgentInstance` is durable for the project's lifetime.

```text
AgentInstance ── durable for project lifetime
    │
    ├─ control-plane lease ── seconds
    │
    └─ executor lease ─────── seconds/minutes
```

Every successful re-acquisition of a resource gets a higher fencing token, and a stale owner cannot renew or release a newer generation:

```text
worker A: fence 41 ── expires
worker B: fence 42 ── owns resource
worker A: late write with 41 ── rejected
```

This fencing is enforced at the persistence layer, not only cooperatively in the runtime. `LeasedAgentRunner` passes an `AgentWriteFence` into `AgentRuntime.run()`, and every durable agent-state transition is persisted through `DurabilityProvider.putAgentFenced()` with that proof attached. `PostgresPersistence.putAgentFenced()` accepts the mutation only when the matching `synth_leases` row still has the same owner/token and is unexpired according to PostgreSQL's own clock; `synth_agents.fencing_token` additionally prevents generation regression at the row level.

```text
lease generation 41 ──> runtime state write ──> DB validates 41 ──> commit
lease generation 42 ──> takeover
stale generation 41 ──> runtime state write ──> DB rejects      ──> stop
```

A stale worker that wakes up after takeover receives `AGENT_FENCE_REJECTED`; it never publishes a false durable completed/failed terminal state. PostgreSQL lease time is authoritative: acquire, renew, release, and `validateLease()` all use `clock_timestamp()`, so worker wall clocks are never part of the ownership decision. `CommandCoordinator` uses the same authoritative `LeaseStore.validateLease()` before terminal commit rather than comparing database timestamps against `Date.now()` from another machine.

Kubernetes executor leases and control-plane agent/command leases are independent of each other. A long-lived logical agent can change control-plane owner and physical sandbox without those two ownership changes being coupled.

## Mailbox

The durable mailbox is append-only from the consumer's perspective. Delivery is at-least-once until ACK; processing becomes effectively-once only if the consumer's own work is idempotent/transactional. The engine cursor advances only after a successful `AgentRuntime.run()`.

`MailboxStore.appendMailbox()` returns `{ envelope, inserted }`. Only the replica whose call actually performed the insertion steers the live engine; a replica that observes an already-inserted envelope (because another replica's append won the race) does not re-steer. This is what prevents duplicate cross-replica steering when multiple runtime replicas share one durable mailbox.

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

## Transaction boundary

The semantic-exposure barrier governs every turn:

```text
snapshot workspace
  → provider/tool attempt
  → buffer semantic output
  → persist semanticExposed=true
  → cross irreversible effect/publication boundary
  → terminal durable commit
```

A crash before semantic exposure may roll back. A crash after exposure requires reconciliation and must not be represented as a transparent replay.

## Inference

`ProfileRouterBackend` does not require process-local health/affinity state. A `RouterStateStore` can be PostgreSQL-backed, and continuation state for `previous_response_id` has the same shared-store shape through `ContinuationStore`. Health state is shared per virtual-model/route; affinity is additionally tenant + virtual-model + session scoped, so a disposable gateway replica does not need process-local memory to route correctly.

## Workspace and physical execution

Normal source manipulation can remain in `MemoryWorkspace`. Commands unsupported by the synthetic shell are escalated through the `ExecutionBroker` to physical resource classes (Kubernetes/gVisor sandboxes). Warm sandbox reset is verified before reuse; a failed reset destroys the slot rather than being handed to the next caller.

## Recovery

`LeasedAgentRunner` adds renewable ownership around a logical run and cancels the runtime if renewal is lost. Recovery of durable agent state in a distributed PostgreSQL deployment occurs under a current agent lease when it needs to mutate an already-fenced `AgentSnapshot`; unfenced local/JSON recovery remains available for explicitly single-writer deployments. See `docs/RECOVERY.md` for the three distinct recovery cases (pre-exposure, post-exposure, abandoned command/effect).

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
