import test from "node:test";
import assert from "node:assert/strict";
import {
  executeGraph,
  matchesCondition,
  newGraphScope,
  resolvePath,
  type GraphHandlers,
  type GraphStep,
} from "../src/graph.js";

function countingHandlers(): { calls: string[]; handlers: GraphHandlers } {
  const calls: string[] = [];
  const counters = new Map<string, number>();
  const handlers: GraphHandlers = {
    async turn(step) {
      calls.push(step.id);
      const count = (counters.get(step.agentId) ?? 0) + 1;
      counters.set(step.agentId, count);
      return { result: { count }, state: "idle" };
    },
    async activity(step) {
      calls.push(`activity:${step.name}`);
      return { name: step.name };
    },
    async child(step) {
      calls.push(`child:${step.workflow}:${step.id}`);
      return { child: step.id };
    },
  };
  return { calls, handlers };
}

test("conditions resolve dotted paths and compare JSON values", () => {
  assert.equal(resolvePath({ a: { b: 2 } }, "a.b"), 2);
  assert.equal(resolvePath({ a: 1 }, "a.b"), undefined);
  assert.equal(matchesCondition({ path: "a.b", equals: 2 }, { a: { b: 2 } }), true);
  assert.equal(matchesCondition({ path: "a.b", equals: 3 }, { a: { b: 2 } }), false);
});

test("executeGraph runs a loop until its condition, joins a fan-out, and branches", async () => {
  const { calls, handlers } = countingHandlers();
  const graph: GraphStep = {
    id: "root",
    kind: "sequence",
    steps: [
      { id: "pre", kind: "turn", agentId: "pre", messages: [] },
      {
        id: "loop",
        kind: "loop",
        maxIterations: 5,
        until: { path: "iter.result.count", equals: 3 },
        body: { id: "iter", kind: "turn", agentId: "iter", messages: [] },
      },
      {
        id: "join",
        kind: "fanout",
        steps: [
          { id: "left", kind: "turn", agentId: "join", messages: [] },
          { id: "right", kind: "turn", agentId: "join", messages: [] },
        ],
      },
      {
        id: "choose",
        kind: "branch",
        condition: { path: "pre.result.count", equals: 1 },
        then: { id: "then", kind: "turn", agentId: "branch", messages: [] },
        else: { id: "else", kind: "turn", agentId: "branch", messages: [] },
      },
    ],
  };
  const scope = newGraphScope();
  const result = await executeGraph(graph, handlers, scope);

  assert.equal(calls.filter((call) => call === "iter").length, 3, "loop body runs until the condition holds");
  assert.equal(calls.filter((call) => call === "left").length, 1);
  assert.equal(calls.filter((call) => call === "right").length, 1);
  assert.equal(calls.includes("then"), true, "the true branch is taken");
  assert.equal(calls.includes("else"), false, "the false branch is not");
  assert.equal(result.children?.length, 4);
  assert.deepEqual(scope.results["loop"], scope.results["iter"], "a loop's value is its last body result");
});

test("executeGraph stops a loop at maxIterations when the condition never holds", async () => {
  const { calls, handlers } = countingHandlers();
  const graph: GraphStep = {
    id: "loop",
    kind: "loop",
    maxIterations: 2,
    until: { path: "body.result.count", equals: 99 },
    body: { id: "body", kind: "turn", agentId: "b", messages: [] },
  };
  const scope = newGraphScope();
  const result = await executeGraph(graph, handlers, scope);
  assert.equal(calls.length, 2);
  assert.equal(result.iterations, 2);
});

test("executeGraph dispatches activity and child nodes", async () => {
  const { calls, handlers } = countingHandlers();
  const graph: GraphStep = {
    id: "seq",
    kind: "sequence",
    steps: [
      { id: "act", kind: "activity", name: "prepare", input: { x: 1 } },
      { id: "nested", kind: "child", workflow: "graph", graph: { id: "inner", kind: "activity", name: "inner" } },
      { id: "agent", kind: "child", workflow: "agent", state: { agentId: "c", status: "idle", mailbox: [], updatedAt: 0 } },
    ],
  };
  const scope = newGraphScope();
  await executeGraph(graph, handlers, scope);
  assert.deepEqual(calls, ["activity:prepare", "child:graph:nested", "child:agent:agent"]);
});

test("executeGraph composes a nested graph through a child node", async () => {
  const calls: string[] = [];
  const scope = newGraphScope();
  const handlers: GraphHandlers = {
    async turn(step) { calls.push(`turn:${step.id}`); return step.id; },
    async activity(step) { calls.push(`activity:${step.name}`); return step.name; },
    async child(step) {
      calls.push(`child:${step.id}`);
      // A real graph child runs as a Temporal child workflow; here the nested
      // graph executes with the same handlers to prove the composition.
      if (step.workflow === "graph") return executeGraph(step.graph, handlers, scope);
      return { agent: step.state.agentId };
    },
  };
  const graph: GraphStep = {
    id: "outer",
    kind: "sequence",
    steps: [
      { id: "before", kind: "turn", agentId: "a", messages: [] },
      {
        id: "sub",
        kind: "child",
        workflow: "graph",
        graph: {
          id: "inner",
          kind: "sequence",
          steps: [
            { id: "inner-loop", kind: "loop", maxIterations: 3, until: { path: "tick", equals: "tick" }, body: { id: "tick", kind: "activity", name: "tick" } },
            { id: "inner-tail", kind: "activity", name: "tail" },
          ],
        },
      },
      { id: "after", kind: "turn", agentId: "a", messages: [] },
    ],
  };
  await executeGraph(graph, handlers, scope);
  assert.deepEqual(calls, ["turn:before", "child:sub", "activity:tick", "activity:tail", "turn:after"]);
});

test("executeGraph calls onNode after every completed node", async () => {
  const { handlers } = countingHandlers();
  const seen: string[] = [];
  const graph: GraphStep = {
    id: "seq",
    kind: "sequence",
    steps: [
      { id: "a", kind: "activity", name: "a" },
      { id: "b", kind: "activity", name: "b" },
    ],
  };
  const scope = newGraphScope();
  await executeGraph(graph, handlers, scope, (current) => { seen.push(current.completed.at(-1)!); });
  assert.deepEqual(seen, ["a", "b", "seq"]);
});

test("executeGraph unwinds when onNode throws (continue-as-new / cancel hook)", async () => {
  const { handlers } = countingHandlers();
  const graph: GraphStep = {
    id: "seq",
    kind: "sequence",
    steps: [
      { id: "a", kind: "activity", name: "a" },
      { id: "b", kind: "activity", name: "b" },
    ],
  };
  const scope = newGraphScope();
  await assert.rejects(executeGraph(graph, handlers, scope, () => { throw new Error("stop"); }), /stop/);
});
