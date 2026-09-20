/**
 * The graph workflow: durable execution of a `GraphStep` (see `graph.ts`).
 *
 * It composes Temporal primitives only — `proxyActivities` for turn/activity
 * nodes, `executeChild` for child workflows (a nested graph, or the
 * agent-lifecycle `durableAgentWorkflow`), and workflow signals/queries for
 * control and state. The interpreter (`executeGraph`) is pure, so the same
 * composition logic is unit-tested without a server.
 *
 * Long histories: `CONTINUE_AS_NEW_AFTER_NODES` is the threshold at which the
 * workflow calls `continueAsNew` carrying the serializable scope, so a long
 * loop/graph does not grow one history without bound. The counter is the
 * completed-node count, checked by the interpreter's `onNode` hook.
 */
import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { AgentActivities, GraphActivities } from "./contracts.js";
import { clone } from "./correlation.js";
import { executeGraph, newGraphScope, type GraphHandlers, type GraphScope, type GraphStep } from "./graph.js";
import { durableAgentWorkflow } from "./workflows.js";

export const cancelGraph = defineSignal("cancelGraph");
export const getGraphState = defineQuery<GraphRunState>("getGraphState");

/** After this many completed nodes the workflow continues-as-new. */
export const CONTINUE_AS_NEW_AFTER_NODES = 1000;

export interface GraphRunState {
  status: "running" | "completed" | "cancelled" | "failed";
  completed: string[];
  iteration: number;
  results: Record<string, unknown>;
  error?: string;
  updatedAt: number;
}

export interface GraphWorkflowInput {
  graph: GraphStep;
  /** Carried across `continueAsNew`; omit on the first run. */
  scope?: GraphScope;
}

const { runTurn } = proxyActivities<AgentActivities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "30 seconds" },
});

const { graphActivity } = proxyActivities<GraphActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "30 seconds" },
});

/** Raised by the `onNode` hook to unwind the interpreter before continue-as-new. */
class ContinueAsNewGraph extends Error {}
/** Raised by the `onNode` hook when `cancelGraph` arrived during the last node. */
class GraphCancelled extends Error {}

const handlers: GraphHandlers = {
  turn: (step) => runTurn({
    agentId: step.agentId,
    messages: step.messages,
    ...(step.config ? { config: step.config } : {}),
  }),
  activity: (step) => graphActivity({ name: step.name, ...(step.input !== undefined ? { input: step.input } : {}) }),
  child: (step) => step.workflow === "graph"
    ? executeChild(runGraphWorkflow, { args: [{ graph: step.graph }] })
    : executeChild(durableAgentWorkflow, { args: [step.state] }),
};

export async function runGraphWorkflow(input: GraphWorkflowInput): Promise<GraphRunState> {
  const scope: GraphScope = input.scope ?? newGraphScope();
  const state: GraphRunState = {
    status: "running",
    // `state` aliases the live scope arrays/objects so a query reflects progress.
    completed: scope.completed,
    iteration: scope.iteration,
    results: scope.results,
    updatedAt: Date.now(),
  };
  let cancelled = false;
  // Newly executed nodes this run. Nodes restored from the journal after a
  // continue-as-new do not count, so a resumed run gets a full threshold's worth
  // of new nodes instead of continuing-as-new after the first one.
  let completedThisRun = 0;
  setHandler(cancelGraph, () => { cancelled = true; });
  setHandler(getGraphState, () => clone(state));

  try {
    await executeGraph(input.graph, handlers, scope, () => {
      state.updatedAt = Date.now();
      // A cancel signal is observed at the next node boundary, so a loop stops
      // within one iteration instead of running to completion.
      if (cancelled) throw new GraphCancelled();
      completedThisRun += 1;
      if (completedThisRun >= CONTINUE_AS_NEW_AFTER_NODES) throw new ContinueAsNewGraph();
    });
    state.status = "completed";
  } catch (error) {
    if (error instanceof GraphCancelled) {
      state.status = "cancelled";
    } else if (error instanceof ContinueAsNewGraph) {
      // All awaited activities have resolved; the scope is plain JSON.
      await continueAsNew<typeof runGraphWorkflow>({ graph: input.graph, scope });
    } else {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
    }
  }
  state.updatedAt = Date.now();
  return state;
}
