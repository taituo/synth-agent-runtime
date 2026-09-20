# Recovery and reconciliation

Durable execution is Temporal's job: `durableAgentWorkflow` owns the agent
lifecycle and mailbox, and every turn runs as the `runTurn` activity. Recovery
is therefore replay + activity retry, with store-level fences and effect
receipts as the backstops. (The former homegrown recovery runtime is deleted and
archived under `docs/history/`.)

## 1. Interrupted turn with no external effect

Temporal retries the activity; the workflow replays committed history, so turns
that already committed are not re-run. The retried activity repeats only the
turn whose result was never recorded.

## 2. Crash near an external effect

`ExecutionBroker` claims an effect by `effect.id` and persists a receipt. In the
shipped Temporal rung the receipts live in Temporal activity state
(`TemporalActivityStateStore`, carried in heartbeat details), so a retried
activity begins with the previous attempt's receipts; the broker's own
`RuntimeStateStore` is swappable (e.g. `PostgresPersistence`). A receipt left
`started` by a crash is returned to a later attempt as
`EFFECT_OUTCOME_UNCERTAIN`, not replayed. A `committed` receipt is replayed
(idempotency key); on a retry the committed effect is not executed again (proven
live by `effect-receipt-live.ts`). Reconciliation of an uncertain effect is an
explicit operator decision; timeout alone is not permission to repeat an
external action.

## 3. Worker death (SIGKILL)

The workflow's activity heartbeat timeout detects the dead worker; Temporal
retries the in-flight activity on a fresh worker and replays the rest. Proven
live, asserting call counts rather than a status:

- `integrations/temporal/durable-restart-worker.ts` — SIGKILLs a worker running
  `durableAgentWorkflow` mid-turn; committed turn `committedCalls=1`, in-flight
  turn `hangCalls=2` (attempts `[1, 2]`), final state idle.
- `integrations/temporal/graph-restart-worker.ts` — SIGKILLs a worker running a
  graph with a loop and a fan-out/join; committed nodes `pre=1, iter=3, left=1,
  right=1`, in-flight node `hang=2`.

## 4. Transient failure / park

A transient activity failure is retried by Temporal; if retries are exhausted the
workflow parks (`waiting`) with exponential backoff and retries the same turn,
honouring a server retry hint when present. An activity may also defer by
returning `state: "waiting"` without consuming its mailbox; that is treated as
the same park.

## Store-level fence

When a durable agent-state mutation must be made for an already-fenced agent in a
distributed deployment, `putAgentFenced()` validates owner, token and DB-time
expiry against `synth_leases` atomically. A stale generation is rejected with
`AGENT_FENCE_REJECTED` rather than silently applied. Covered by
`test/postgres-control.test.ts` and the live 32-worker proof. See
`docs/HARDENING.md` for the full fencing model.
