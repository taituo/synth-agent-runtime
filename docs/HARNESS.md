# The Temporal graph harness

> Status: landed and tested. The interpreter (`integrations/temporal/src/graph.ts`)
> and the workflow (`graph-workflow.ts`) exist; loops, fan-out/join and branches
> are unit-tested, and a live proof SIGKILLs a worker mid-graph and shows
> committed nodes are not re-run. Child workflows and continue-as-new are wired
> and unit-tested at the dispatch/hook level but not yet live-proven. See
> `docs/KNOWN-OPEN.md`.

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

`CONTINUE_AS_NEW_AFTER_NODES` (1000) is the completed-node count at which the
workflow calls `continueAsNew` carrying the serializable scope, so a long
loop/graph does not grow one history without bound.

## The interpreter is pure

`executeGraph(step, handlers, scope, onNode?)` has no Temporal imports. The
workflow supplies Temporal handlers; a unit test supplies fake ones and asserts
the call sequence. `onNode` fires after every completed node; the workflow uses
it for cancellation and the continue-as-new threshold.

## Evidence

- `integrations/temporal/test/graph.test.ts` — 7 unit tests: loop-until,
  max-iterations, fan-out join, branch, nested graph, activity/child dispatch,
  `onNode` hook and unwind. Fails (module not found) without the interpreter.
- `integrations/temporal/graph-restart-worker.ts` — live proof: a graph of
  `pre -> loop(iter ×3) -> fanout(left, right) -> hang`, SIGKILLed while `hang`
  is in flight. Per-node call counts after recovery: `pre=1`, `iter=3`,
  `left=1`, `right=1`, `hang=2`; status `completed`. Wired into
  `scripts/live-proofs.mjs` as `graph-restart`.

## Not done yet

- A live nested-child proof (child workflows are only unit-tested at dispatch).
- Compensation, per-node timeouts, and human-in-the-loop approval signals.
- The gym's attempt workflow driving this harness (the `gym-2` workstream).
