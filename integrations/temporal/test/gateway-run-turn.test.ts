import test from "node:test";
import assert from "node:assert/strict";
import type { AgentId } from "../../../src/core/ids.js";
import { LocalMemoryDurability } from "../../../src/durability/local-memory.js";
import type { AgentEngine } from "../../../src/runtime/agent-engine.js";
import { AgentRuntime } from "../../../src/runtime/agent-runtime.js";
import { createGatewayAgentEngine } from "../../../src/runtime/gateway-engine.js";
import type { DurableMailboxMessage } from "../src/contracts.js";
import {
  TRIAGE_SYSTEM_PROMPT,
  buildTriageUserMessage,
  createGatewayRunTurn,
  extractJsonObject,
  parseClassifications,
  type GatewayTurnRecord,
} from "../src/gateway-run-turn.js";

function message(text: string, kind?: string): DurableMailboxMessage {
  return { id: `m-${text}`, role: "human", text, createdAt: 1, ...(kind ? { kind } : {}) };
}

function chatReply(content: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ model: "test-model", choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 7 }, ...extra }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("sends a chat completion for the whole batch and never leaks the planted kind", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const records: GatewayTurnRecord[] = [];
  const runTurn = createGatewayRunTurn({
    baseUrl: "http://gw.test/",
    model: "test-model",
    apiKey: "secret-key",
    heartbeat: () => {},
    onTurn: (record) => records.push(record),
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return chatReply(JSON.stringify({ events: [
        { classification: "news", reaction: "log it" },
        { classification: "INCIDENT", reaction: "page on-call" },
      ] }));
    }) as unknown as typeof fetch,
  });

  const result = await runTurn({
    agentId: "agt_1",
    messages: [message("central bank holds rates", "PLANTED_KIND_MARKER_A"), message("checkout is returning 503", "PLANTED_KIND_MARKER_B")],
  });

  assert.equal(seen!.url, "http://gw.test/v1/chat/completions");
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer secret-key");
  const body = String(seen!.init.body);
  assert.match(body, /central bank holds rates/);
  assert.match(body, /checkout is returning 503/);
  assert.equal(body.includes("PLANTED_KIND_MARKER"), false, "the typed kind must stay hidden from the model");
  assert.equal(JSON.parse(body).model, "test-model");

  assert.equal(result.state, "idle");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]!.plantedKinds, ["PLANTED_KIND_MARKER_A", "PLANTED_KIND_MARKER_B"]);
  // Classification is normalised to lower case.
  assert.deepEqual(records[0]!.classifications.map((entry) => entry.classification), ["news", "incident"]);
  assert.equal(records[0]!.usage?.total_tokens, 7);
});

test("records the model that actually answered, and flags a substitution", async () => {
  const records: GatewayTurnRecord[] = [];
  const runTurn = createGatewayRunTurn({
    baseUrl: "http://gw.test",
    model: "requested-model",
    heartbeat: () => {},
    onTurn: (record) => records.push(record),
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          model: "different-model",
          choices: [{ message: { role: "assistant", content: '{"events":[{"classification":"news","reaction":"ok"}]}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  });
  await runTurn({ agentId: "a", messages: [message("x")] });
  assert.equal(records[0]!.requestedModel, "requested-model");
  assert.equal(records[0]!.servedModel, "different-model");
  assert.equal(records[0]!.modelSubstituted, true, "a router substitution must be flagged, not hidden");
});

test("an upstream that omits the model field is recorded as unknown, never guessed", async () => {
  const records: GatewayTurnRecord[] = [];
  const runTurn = createGatewayRunTurn({
    baseUrl: "http://gw.test",
    model: "requested-model",
    heartbeat: () => {},
    onTurn: (record) => records.push(record),
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"events":[{"classification":"news","reaction":"ok"}]}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  });
  await runTurn({ agentId: "a", messages: [message("x")] });
  assert.equal(records[0]!.requestedModel, "requested-model");
  assert.equal(records[0]!.servedModel, null, "the upstream did not say which model answered");
  assert.equal(records[0]!.modelSubstituted, false, "an unknown served model is not a substitution");
});

test("records a matching served model with no substitution flag", async () => {
  const records: GatewayTurnRecord[] = [];
  const runTurn = createGatewayRunTurn({
    baseUrl: "http://gw.test",
    model: "test-model",
    heartbeat: () => {},
    onTurn: (record) => records.push(record),
    fetchImpl: (async () => chatReply('{"events":[{"classification":"news","reaction":"ok"}]}')) as unknown as typeof fetch,
  });
  await runTurn({ agentId: "a", messages: [message("x")] });
  assert.equal(records[0]!.requestedModel, "test-model");
  assert.equal(records[0]!.servedModel, "test-model");
  assert.equal(records[0]!.modelSubstituted, false);
});

test("tolerates a code-fenced JSON reply and surrounding prose", () => {
  const json = '{"events":[{"classification":"news","reaction":"x"}]}';
  assert.deepEqual(extractJsonObject("```json\n" + json + "\n```"), JSON.parse(json));
  assert.deepEqual(extractJsonObject("Sure! Here you go: " + json + " Hope that helps."), JSON.parse(json));
  assert.equal(parseClassifications(json, 1)[0]!.classification, "news");
});

test("rejects structurally invalid answers so Temporal's retry policy can decide", () => {
  assert.throws(() => parseClassifications('{"events":[]}', 2), /0 classifications for 2 events/);
  assert.throws(() => parseClassifications('{"nope":1}', 1), /no "events" array/);
  assert.throws(() => parseClassifications('{"events":[{"reaction":"x"}]}', 1), /no string classification/);
  assert.throws(() => parseClassifications("I cannot help with that", 1), /not JSON/);
  // Track 2: a model that obeys a prompt injection and replies "OK" must be
  // rejected, not accepted as a bogus shape.
  assert.throws(() => parseClassifications("OK", 1), /not JSON/);
});

test("a non-2xx gateway reply and an empty completion both throw", async () => {
  const failing = createGatewayRunTurn({
    baseUrl: "http://gw.test",
    model: "m",
    heartbeat: () => {},
    fetchImpl: (async () => new Response("upstream exploded", { status: 502 })) as unknown as typeof fetch,
  });
  await assert.rejects(failing({ agentId: "a", messages: [message("x")] }), /HTTP 502: upstream exploded/);

  const empty = createGatewayRunTurn({
    baseUrl: "http://gw.test",
    model: "m",
    heartbeat: () => {},
    fetchImpl: (async () => chatReply("")) as unknown as typeof fetch,
  });
  await assert.rejects(empty({ agentId: "a", messages: [message("x")] }), /no message content/);
});

test("classifies gateway HTTP errors as permanent (non-retryable) or transient", async () => {
  const make = (status: number) =>
    createGatewayRunTurn({
      baseUrl: "http://gw.test",
      model: "m",
      heartbeat: () => {},
      fetchImpl: (async () => new Response("nope", { status })) as unknown as typeof fetch,
    });
  for (const status of [400, 401, 402, 403, 404, 422]) {
    await assert.rejects(make(status)({ agentId: "a", messages: [message("x")] }), (error: unknown) => {
      assert.equal((error as { nonRetryable?: boolean }).nonRetryable, true, `HTTP ${status} should be permanent`);
      return true;
    });
  }
  for (const status of [408, 409, 425, 429, 500, 502, 503]) {
    await assert.rejects(make(status)({ agentId: "a", messages: [message("x")] }), (error: unknown) => {
      assert.notEqual((error as { nonRetryable?: boolean }).nonRetryable, true, `HTTP ${status} should be transient`);
      return true;
    });
  }
});

test("heartbeats while waiting on a slow model (the workflow enforces a heartbeat timeout)", async () => {
  let beats = 0;
  const runTurn = createGatewayRunTurn({
    baseUrl: "http://gw.test",
    model: "m",
    heartbeatIntervalMs: 10,
    heartbeat: () => { beats++; },
    fetchImpl: (async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return chatReply('{"events":[{"classification":"news","reaction":"ok"}]}');
    }) as unknown as typeof fetch,
  });
  await runTurn({ agentId: "a", messages: [message("x")] });
  assert.ok(beats >= 4, `expected several heartbeats during a 90ms call, saw ${beats}`);
  const after = beats;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(beats, after, "the heartbeat timer must be cleared once the call finishes");
});

test("aborts a call that outlives its timeout instead of hanging the turn", async () => {
  const runTurn = createGatewayRunTurn({
    baseUrl: "http://gw.test",
    model: "m",
    timeoutMs: 30,
    heartbeat: () => {},
    fetchImpl: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch,
  });
  await assert.rejects(runTurn({ agentId: "a", messages: [message("x")] }), /timed out|abort/i);
});

test("user message lists every event in order", () => {
  assert.equal(
    buildTriageUserMessage([message("first"), message("second")]),
    "Classify these 2 event(s), in order:\n1. first\n2. second",
  );
});

test("runTurn invokes the shared engine body and makes no HTTP call of its own", async () => {
  const engineCalls: Array<readonly unknown[]> = [];
  let rawHttpCalls = 0;
  const engine: AgentEngine = {
    async run(messages) {
      engineCalls.push(messages);
      return {
        content: JSON.stringify({ events: [{ classification: "incident", reaction: "page on-call" }] }),
        toolCalls: [],
        observations: [],
        requestedModel: "m",
        servedModel: "m",
        modelSubstituted: false,
        latencyMs: 3,
      };
    },
  };
  const runTurn = createGatewayRunTurn({
    baseUrl: "http://gw.test",
    model: "m",
    heartbeat: () => {},
    engine,
    fetchImpl: (async () => {
      rawHttpCalls++;
      throw new Error("the activity must not make its own HTTP call");
    }) as unknown as typeof fetch,
  });

  const result = await runTurn({ agentId: "a", messages: [message("central bank holds rates")] });

  assert.equal(engineCalls.length, 1, "the activity must invoke the shared body exactly once");
  assert.equal(engineCalls[0]!.length, 1);
  assert.equal(rawHttpCalls, 0, "the old raw-HTTP turn path must be gone");
  assert.deepEqual((result.result as { classifications: unknown[] }).classifications, [
    { classification: "incident", reaction: "page on-call" },
  ]);
});

test("the durable activity and the in-process driver run the same engine body", async () => {
  const bodies: string[] = [];
  let engineRuns = 0;
  const body = createGatewayAgentEngine({
    baseUrl: "http://gw.test",
    model: "m",
    heartbeat: () => {},
    systemPrompt: TRIAGE_SYSTEM_PROMPT,
    buildUserMessage: (messages) => buildTriageUserMessage(messages),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return chatReply('{"events":[{"classification":"news","reaction":"log it"}]}');
    }) as unknown as typeof fetch,
  });
  const engine: AgentEngine = {
    async run(messages, context) {
      engineRuns++;
      return body.run(messages, context);
    },
  };

  // Durable path: the workflow's runTurn activity.
  const runTurn = createGatewayRunTurn({ baseUrl: "http://gw.test", model: "m", heartbeat: () => {}, engine });
  await runTurn({ agentId: "agt_shared", messages: [message("event one")] });

  // In-process path: AgentRuntime.run with the same engine.
  const runtime = new AgentRuntime(new LocalMemoryDurability());
  const workspace = await runtime.createWorkspace();
  await runtime.spawn({
    id: "agt_shared" as AgentId,
    definition: { id: "def", inferenceProfile: { id: "m", model: "m" } },
    engine,
    workspace,
  });
  await runtime.send("agt_shared" as AgentId, "event one");
  await runtime.run("agt_shared" as AgentId);

  assert.equal(engineRuns, 2, "both drivers must go through the one shared body");
  assert.equal(bodies.length, 2, "both drivers must reach the gateway through that body");
  assert.equal(bodies[0], bodies[1], "the shared body must build the same request for both drivers");
});
