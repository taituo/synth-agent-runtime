/**
 * The step graph: a minimal, typed, serializable composition layer for durable
 * flows. It has no Temporal imports, so the same interpreter runs in the
 * workflow isolate (with Temporal handlers) and in a plain unit test (with fake
 * handlers). The Temporal wrapper is `graph-workflow.ts`.
 *
 * Nodes are agent turns (the `runTurn` activity), named activities, or child
 * workflows (a nested graph, or the agent-lifecycle `durableAgentWorkflow`).
 * Edges are expressed by the composite nodes: `sequence`, `fanout` (parallel
 * children, joined when all complete), `branch` (conditional), and `loop`
 * (iterate until a serializable condition, with a durable counter).
 *
 * Conditions are DATA, never closures: a dotted path into the accumulated node
 * results compared to a JSON value. That keeps the graph serializable and the
 * workflow deterministic.
 */
import type { DurableAgentState, DurableMailboxMessage, DurableTurnConfig } from "./contracts.js";

/** A serializable predicate: `results[path]` deep-equals `equals`. */
export interface GraphCondition {
  /** Dotted path into the accumulated results, e.g. `"iter.result.count"`. */
  path: string;
  equals: unknown;
}

export type GraphStep =
  | { id: string; kind: "turn"; agentId: string; messages: DurableMailboxMessage[]; config?: DurableTurnConfig }
  | { id: string; kind: "activity"; name: string; input?: unknown }
  | { id: string; kind: "child"; workflow: "agent"; state: DurableAgentState }
  | { id: string; kind: "child"; workflow: "graph"; graph: GraphStep }
  | { id: string; kind: "sequence"; steps: GraphStep[] }
  | { id: string; kind: "fanout"; steps: GraphStep[] }
  | { id: string; kind: "branch"; condition: GraphCondition; then: GraphStep; else?: GraphStep }
  | { id: string; kind: "loop"; body: GraphStep; maxIterations: number; until: GraphCondition };

export type TurnStep = Extract<GraphStep, { kind: "turn" }>;
export type ActivityStep = Extract<GraphStep, { kind: "activity" }>;
export type ChildStep = Extract<GraphStep, { kind: "child" }>;

export interface StepResult {
  nodeId: string;
  value: unknown;
  /** For a loop: how many iterations ran. */
  iterations?: number;
  children?: StepResult[];
}

/** The Temporal-backed operations the interpreter composes. */
export interface GraphHandlers {
  turn(step: TurnStep): Promise<unknown>;
  activity(step: ActivityStep): Promise<unknown>;
  child(step: ChildStep): Promise<unknown>;
}

export interface GraphScope {
  /** Node outputs by id, so conditions can read earlier results. */
  results: Record<string, unknown>;
  /** The loop iteration currently executing (0 for non-loop nodes). */
  iteration: number;
  /** Node ids in completion order, for observability and continue-as-new. */
  completed: string[];
  /**
   * Completed node occurrences, keyed by a deterministic execution path (see
   * `executeGraph`). A continue-as-new carries this, so the resumed run skips
   * work already done instead of re-running the whole graph. Values live in
   * `results`; the journal only records which occurrences are complete.
   */
  journal: Record<string, true>;
}

export function newGraphScope(): GraphScope {
  return { results: {}, iteration: 0, completed: [], journal: {} };
}

export function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function matchesCondition(condition: GraphCondition, results: Record<string, unknown>): boolean {
  return JSON.stringify(resolvePath(results, condition.path)) === JSON.stringify(condition.equals);
}

/**
 * Execute one step and its descendants, recording each result in the scope.
 * `onNode` runs after every newly executed node completes; the workflow uses it
 * to observe cancellation and the continue-as-new threshold between nodes.
 *
 * `path` is the node's deterministic occurrence key (structure position plus
 * loop iteration). `journal` records the occurrences already complete: when a
 * continue-as-new resumes, `executeGraph` finds them and returns the carried
 * result without calling the handler again. A cache-hit result carries the
 * value but not `children`/`iterations`; only the value is consumed downstream.
 */
export async function executeGraph(
  step: GraphStep,
  handlers: GraphHandlers,
  scope: GraphScope,
  onNode?: (scope: GraphScope) => void,
  path: string = step.id,
): Promise<StepResult> {
  // Defensive for a scope persisted before the journal existed.
  scope.journal ??= {};
  if (scope.journal[path] === true) {
    return { nodeId: step.id, value: scope.results[step.id] };
  }
  const result = await runStep(step, handlers, scope, onNode, path);
  scope.results[step.id] = result.value;
  scope.completed.push(step.id);
  scope.journal[path] = true;
  onNode?.(scope);
  return result;
}

async function runStep(step: GraphStep, handlers: GraphHandlers, scope: GraphScope, onNode: ((scope: GraphScope) => void) | undefined, path: string): Promise<StepResult> {
  switch (step.kind) {
    case "turn":
      return { nodeId: step.id, value: await handlers.turn(step) };
    case "activity":
      return { nodeId: step.id, value: await handlers.activity(step) };
    case "child":
      return { nodeId: step.id, value: await handlers.child(step) };
    case "sequence": {
      const children: StepResult[] = [];
      for (let i = 0; i < step.steps.length; i++) {
        const child = step.steps[i]!;
        children.push(await executeGraph(child, handlers, scope, onNode, `${path}/${i}:${child.id}`));
      }
      return { nodeId: step.id, value: children.at(-1)?.value, children };
    }
    case "fanout": {
      // Parallel children, joined when all complete. Temporal makes this
      // deterministic; a unit test asserts call counts, not completion order.
      const children = await Promise.all(step.steps.map((child, i) => executeGraph(child, handlers, scope, onNode, `${path}/${i}:${child.id}`)));
      return { nodeId: step.id, value: children.map((child) => child.value), children };
    }
    case "branch": {
      const takenThen = matchesCondition(step.condition, scope.results);
      const chosen = takenThen ? step.then : step.else;
      if (!chosen) return { nodeId: step.id, value: undefined };
      const child = await executeGraph(chosen, handlers, scope, onNode, `${path}/${takenThen ? "then" : "else"}:${chosen.id}`);
      return { nodeId: step.id, value: child.value, children: [child] };
    }
    case "loop": {
      // Resume at the first iteration not already journaled. A continue-as-new
      // can preempt the `until` check immediately after a body node completes,
      // so re-evaluate it against the carried last result before running more.
      let start = 0;
      while (start < step.maxIterations && scope.journal[`${path}#${start}/${step.body.id}`] === true) start++;
      if (start > 0 && matchesCondition(step.until, scope.results)) {
        return { nodeId: step.id, value: scope.results[step.body.id], iterations: start, children: [] };
      }
      const children: StepResult[] = [];
      let iterations = start;
      for (let i = start; i < step.maxIterations; i++) {
        scope.iteration = i;
        children.push(await executeGraph(step.body, handlers, scope, onNode, `${path}#${i}/${step.body.id}`));
        iterations = i + 1;
        if (matchesCondition(step.until, scope.results)) break;
      }
      scope.iteration = 0;
      return { nodeId: step.id, value: children.at(-1)?.value, iterations, children };
    }
  }
}

/** A completed node id, for the workflow's `completed` state and continue-as-new. */
export function graphNodeCount(scope: GraphScope): number {
  return scope.completed.length;
}
