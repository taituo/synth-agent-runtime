/**
 * The swarm gateway turn: parses swarm tool calls out of an OpenAI-compatible
 * reply and records requested/served model. Fake fetch, so zero model cost.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGatewaySwarmTurn, coerceSwarmToolCalls, extractSwarmToolCalls } from "../src/swarm/turn.js";
import { SWARM_TOOL_DEFINITIONS, buildSwarmSystemPrompt } from "../src/swarm/tools.js";
import type { SwarmTurnInput } from "../src/swarm/attempt.js";

const INPUT: SwarmTurnInput = {
  turnIndex: 0,
  streamName: "planted-ops-stream-v1",
  systemPrompt: "sys",
  userPrompt: "user",
  transcript: [],
  tools: SWARM_TOOL_DEFINITIONS,
  findings: [],
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) })) as unknown as typeof fetch;
}

test("a structured tool_calls reply becomes swarm calls and records the served model", async () => {
  const turn = createGatewaySwarmTurn({
    baseUrl: "http://gateway",
    model: "requested/model",
    fetchImpl: fakeFetch({
      model: "served/model",
      choices: [{ message: { content: null, tool_calls: [{ function: { name: "report_finding", arguments: JSON.stringify({ kind: "incident", summary: "x", evidence: ["inc-1"] }) } }] } }],
    }),
  });
  const result = await turn(INPUT);
  assert.deepEqual(result.toolCalls, [{ name: "report_finding", arguments: { kind: "incident", summary: "x", evidence: ["inc-1"] } }]);
  assert.equal(result.requestedModel, "requested/model");
  assert.equal(result.servedModel, "served/model");
  assert.equal(result.modelSubstituted, true, "a different served model must be flagged");
});

test("a tool call written as fenced JSON content is recovered", async () => {
  const content = "I will read one event.\n```json\n{\"tool_calls\":[{\"name\":\"read_event\",\"arguments\":{\"id\":\"inc-2\"}}]}\n```";
  const turn = createGatewaySwarmTurn({
    baseUrl: "http://gateway",
    model: "m",
    fetchImpl: fakeFetch({ model: "m", choices: [{ message: { content } }] }),
  });
  const result = await turn(INPUT);
  assert.deepEqual(result.toolCalls, [{ name: "read_event", arguments: { id: "inc-2" } }]);
  assert.equal(result.modelSubstituted, false);
});

test("content with no parseable call yields finish, so the loop terminates", async () => {
  const turn = createGatewaySwarmTurn({
    baseUrl: "http://gateway",
    model: "m",
    fetchImpl: fakeFetch({ model: "m", choices: [{ message: { content: "No signals found." } }] }),
  });
  const result = await turn(INPUT);
  assert.deepEqual(result.toolCalls, [{ name: "finish", arguments: {} }]);
});

test("the system prompt demands JSON tool_calls and lists every tool", () => {
  // The gateway request carries no `tools` schema, so the prompt is the only
  // place the model learns the call format. Without this instruction the live
  // run recovered 0 of 3 planted signals; with it, 3 of 3.
  const prompt = buildSwarmSystemPrompt();
  assert.match(prompt, /\{"tool_calls":\[\{"name":"<tool>","arguments":\{\.\.\.\}\}\]\}/);
  assert.match(prompt, /Reply with ONLY a JSON object/);
  for (const tool of SWARM_TOOL_DEFINITIONS) assert.ok(prompt.includes(tool.name), `prompt must list ${tool.name}`);
});

test("an unknown tool name passes through rather than being silently dropped", () => {
  const calls = coerceSwarmToolCalls([{ name: "delete_everything", arguments: {} }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "delete_everything");
});

test("extractSwarmToolCalls reads a bare array and a single object", () => {
  assert.deepEqual(extractSwarmToolCalls('[{"name":"finish","arguments":{}}]'), [{ name: "finish", arguments: {} }]);
  assert.deepEqual(extractSwarmToolCalls('{"name":"list_events","arguments":{}}'), [{ name: "list_events", arguments: {} }]);
  assert.deepEqual(extractSwarmToolCalls("not json at all"), []);
});
