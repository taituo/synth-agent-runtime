# The Temporal graph harness

> Status: landed and tested. The interpreter (`integrations/temporal/src/graph.ts`)
> and the workflow (`graph-workflow.ts`) exist; loops, fan-out/join and branches
> are unit-tested, and four live proofs run against Temporal `:7243`: a worker
> SIGKILL mid-graph where committed nodes are not re-run (`graph-restart`), a
> real child workflow the parent waits on (`graph-child`), a loop that crosses
> `CONTINUE_AS_NEW_AFTER_NODES` and resumes (`graph-continue-as-new`), and
> `cancelGraph` stopping a real long loop (`graph-cancel`). Compensation and
> per-node timeouts are still not done. See `docs/KNOWN-OPEN.md`.

`durableAgentWorkflow` is the agent-lifecycle leaf: a mailbox plus a turn loop.
The graph harness is the composition layer around it — how several agents/turns
are wired into a durable flow. It adds no turn body; turn nodes call the same
`runTurn` activity, and child nodes run `durableAgentWorkflow` or a nested graph.

## The graph is data

`GraphStep` is serializable, so it travels in the workflow input and through
`continueAsNew`:

- `turn` — one agent turn: calls the `runTurn` activity with `{ agentId, messages, config }`.
- `activity` — a named activity (`graphActivity`); a worker that never runs one need not supply it.
- `child` — a child workflow: `workflow: "agent"` runs `durableAgentWorkflow`; `workflow: "graph"` runs a nested graph.
- `sequence` — ordered children.
- `fanout` — parallel children, joined when all complete (`Promise.all`).
- `branch` — a conditional: `condition` is a serializable predicate.
- `loop` — iterate `body` until `until` holds or `maxIterations` is reached; the iteration counter lives in the workflow state.

A condition is `{ path, equals }`: a dotted path into the accumulated node
results (`scope.results`) compared to a JSON value. Conditions are data, never
closures, so the workflow stays deterministic.

## The workflow

`runGraphWorkflow({ graph, scope? })` runs the graph with Temporal-backed
handlers and exposes:

- signal `cancelGraph` — observed at the next node boundary; a loop stops within one iteration.
- query `getGraphState` — `{ status, completed, iteration, results, error }`.

`CONTINUE_AS_NEW_AFTER_NODES` (1000) is the number of nodes executed **in the
current run** at which the workflow calls `continueAsNew`, carrying the
serializable scope, so a long loop/graph does not grow one history without
bound. To resume without re-running work, the scope carries a `journal` of
completed node occurrences keyed by a deterministic execution path (structure
position plus loop iteration). `executeGraph` skips a journaled occurrence and
returns the carried result; a loop resumes at the first iteration not in the
journal. `results` still holds the latest value per node id (so conditions work
unchanged); the journal only records which occurrences are done.

## The interpreter is pure

`executeGraph(step, handlers, scope, onNode?)` has no Temporal imports. The
workflow supplies Temporal handlers; a unit test supplies fake ones and asserts
the call sequence. `onNode` fires after every completed node; the workflow uses
it for cancellation and the continue-as-new threshold.

## Evidence

- `integrations/temporal/test/graph.test.ts` — 8 unit tests: loop-until,
  max-iterations, fan-out join, branch, nested graph, activity/child dispatch,
  `onNode` hook and unwind, and resume-after-continue-as-new. Fails (module not
  found) without the interpreter.
- `integrations/temporal/graph-restart-worker.ts` (`graph-restart`) — live:
  `pre -> loop(iter ×3) -> fanout(left, right) -> hang`, SIGKILLed while `hang`
  is in flight. Per-node call counts after recovery: `pre=1`, `iter=3`,
  `left=1`, `right=1`, `hang=2`; status `completed`.
- `integrations/temporal/graph-child-live.ts` (`graph-child`) — live:
  `pre -> child(nested graph) -> after`. Parent history has
  `StartChildWorkflowExecutionInitiated` with `workflowType.name =
  runGraphWorkflow` and a child run id distinct from the parent's, then
  `ChildWorkflowExecutionStarted`/`Completed`; the parent result embeds the
  child's `GraphRunState` (`inner-a`, `inner-b`, `inner`), and the activity log
  orders the child's nodes between the parent's `pre` and `after`.
- `integrations/temporal/graph-continue-as-new-live.ts`
  (`graph-continue-as-new`) — live: a loop until `iter.result.count == 1100`
  crosses the 1000-node threshold. The run chain has 1
  `WorkflowExecutionContinuedAsNew` event and the final run has a
  `WorkflowExecutionCompleted` event; the loop ran exactly 1100 iterations with
  1100 distinct counts (the resumed run skipped the 1000 journaled iterations).
- `integrations/temporal/graph-cancel-live.ts` (`graph-cancel`) — live:
  `cancelGraph` against a real 200 ms loop. The counter is 3 at cancel, 3 after
  the workflow returns, and still 3 a second later; status `cancelled`.

All four are wired into `scripts/live-proofs.mjs` (both `requires: temporal`).

## Not done yet

- Compensation and per-node timeouts.
- Human-in-the-loop approval signals.
- The gym's attempt workflow driving this harness (the `gym-2` workstream).
- A continue-as-new proof with large node values: the journal lives in the
  continue-as-new input, whose payload is bounded (Temporal's ~2 MB default).
  Node values are small here; a graph that carries large artifacts would need
  them by reference instead of inline.
