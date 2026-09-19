import test from "node:test";
import assert from "node:assert/strict";
import { bridgeWorkflowId } from "../src/bridge-client.js";
import { createHttpHarnessBridgeActivities } from "../src/bridge-activities.js";

test("bridge workflow ids are stable and scoped by operation kind", () => {
  const input = { agentId: "a", sessionId: "s", callId: "c" };
  assert.equal(bridgeWorkflowId("infer", input), bridgeWorkflowId("infer", input));
  assert.notEqual(bridgeWorkflowId("infer", input), bridgeWorkflowId("tool", input));
  assert.notEqual(
    bridgeWorkflowId("tool", input),
    bridgeWorkflowId("tool", { ...input, callId: "other" }),
  );
});

test("inference activity preserves upstream status and selected headers", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const activities = createHttpHarnessBridgeActivities({
    inferenceBaseUrl: "https://models.example",
    inferenceApiKey: "secret",
    allowedToolCallbackOrigins: ["https://harness.example"],
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response('{"ok":true}', {
        status: 429,
        headers: { "content-type": "application/json", "x-request-id": "req-1", "x-secret": "drop" },
      });
    },
  });
  const result = await activities.forwardInference({
    agentId: "a",
    sessionId: "s",
    callId: "c",
    api: "chat.completions",
    body: { model: "x" },
  });
  assert.equal(calls[0]?.url, "https://models.example/v1/chat/completions");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer secret");
  assert.equal(result.status, 429);
  assert.deepEqual(result.headers, {
    "content-type": "application/json",
    "x-request-id": "req-1",
  });
});

test("tool activity rejects callback origins outside the worker allowlist", async () => {
  let fetched = false;
  const activities = createHttpHarnessBridgeActivities({
    inferenceBaseUrl: "https://models.example",
    allowedToolCallbackOrigins: ["https://allowed.example"],
    fetchImpl: async () => {
      fetched = true;
      return new Response('{"result":"ok"}');
    },
  });
  await assert.rejects(
    activities.forwardToolExecution({
      agentId: "a",
      sessionId: "s",
      toolCallId: "tc",
      toolName: "exec",
      arguments: {},
      callbackUrl: "https://evil.example/execute",
    }),
    /not allowed/,
  );
  assert.equal(fetched, false);
});

test("tool activity rejects an allowed origin with a non-callback path", async () => {
  const activities = createHttpHarnessBridgeActivities({
    inferenceBaseUrl: "https://models.example",
    allowedToolCallbackOrigins: ["https://allowed.example"],
    fetchImpl: async () => new Response('{"result":"no"}'),
  });
  await assert.rejects(
    activities.forwardToolExecution({
      agentId: "a",
      sessionId: "s",
      toolCallId: "tc",
      toolName: "exec",
      arguments: {},
      callbackUrl: "https://allowed.example/admin",
    }),
    /exact \/execute endpoint/,
  );
});

test("tool activity posts the exact call to an allowed harness callback", async () => {
  let seen: { url?: string; body?: unknown; auth?: string } = {};
  const activities = createHttpHarnessBridgeActivities({
    inferenceBaseUrl: "https://models.example",
    allowedToolCallbackOrigins: ["https://allowed.example"],
    toolCallbackBearerToken: "callback-secret",
    fetchImpl: async (input, init) => {
      seen = {
        url: String(input),
        body: JSON.parse(String(init?.body)),
        auth: (init?.headers as Record<string, string>).authorization,
      };
      return new Response('{"result":{"ok":true}}', { status: 200 });
    },
  });
  const request = {
    agentId: "a",
    sessionId: "s",
    toolCallId: "tc",
    toolName: "exec",
    arguments: { command: "true" },
    callbackUrl: "https://allowed.example/execute",
    metadata: { taskId: "t" },
  };
  assert.deepEqual(await activities.forwardToolExecution(request), { result: { ok: true } });
  assert.equal(seen.url, request.callbackUrl);
  assert.equal(seen.auth, "Bearer callback-secret");
  assert.deepEqual(seen.body, request);
});
