/**
 * Step 5: the plain arm's turn — one direct OpenAI-compatible request. Tested
 * with a fake fetch so no model call is spent, and so the tool-call protocol and
 * model attribution are pinned.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayGymTurn, createScriptedGymTurn, GYM_TOOL_DEFINITIONS, parseRetryAfterMs } from "../src/index.js";

const INPUT = {
  turnIndex: 0,
  repoDir: "/tmp/does-not-matter",
  visibleTestPath: "test/visible.test.mjs",
  systemPrompt: "SYS",
  userPrompt: "USER",
  transcript: [],
  tools: GYM_TOOL_DEFINITIONS,
};

function fakeFetch(response: { status?: number; body: unknown }, capture?: (init: RequestInit) => void): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    capture?.(init ?? {});
    const status = response.status ?? 200;
    const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("the plain turn parses tool_calls and records the served model", async () => {
  let body: { model?: string; messages?: unknown[] } | undefined;
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    fetchImpl: fakeFetch({ body: { model: "served-other", choices: [{ message: { content: JSON.stringify({ tool_calls: [{ name: "finish" }] }) } }] } }, (init) => {
      body = JSON.parse(String(init.body)) as { model?: string; messages?: unknown[] };
    }),
  });
  const result = await turn(INPUT);
  assert.deepEqual(result.toolCalls, [{ name: "finish", arguments: {} }]);
  assert.equal(result.requestedModel, "wanted");
  assert.equal(result.servedModel, "served-other");
  assert.equal(result.modelSubstituted, true);
  assert.equal(body?.model, "wanted");
  assert.equal((body?.messages as unknown[])?.length, 2, "system + user prompt");
});

test("an omitted served model is recorded as unknown, never guessed", async () => {
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    fetchImpl: fakeFetch({ body: { choices: [{ message: { content: JSON.stringify({ tool_calls: [{ name: "finish" }] }) } }] } }),
  });
  const result = await turn(INPUT);
  assert.equal(result.servedModel, null);
  assert.equal(result.modelSubstituted, false);
});

test("an unknown tool name is passed through so the executor can report it", async () => {
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    fetchImpl: fakeFetch({ body: { choices: [{ message: { content: JSON.stringify({ tool_calls: [{ name: "search_in_file", arguments: { pattern: "x" } }] }) } }] } }),
  });
  const result = await turn(INPUT);
  assert.equal(result.toolCalls[0]?.name, "search_in_file");
});

test("a non-JSON reply throws so the attempt records errored", async () => {
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    fetchImpl: fakeFetch({ body: { choices: [{ message: { content: "I cannot help with that." } }] } }),
  });
  await assert.rejects(() => turn(INPUT), /not JSON/);
});

test("an HTTP error throws so the attempt records errored", async () => {
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    fetchImpl: fakeFetch({ status: 500, body: "boom" }),
  });
  await assert.rejects(() => turn(INPUT), /HTTP 500/);
});

test("a 429 carries the Retry-After hint across the error boundary", async () => {
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    fetchImpl: (async () => new Response("rate limited", { status: 429, headers: { "retry-after": "2" } })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => turn(INPUT),
    (error: unknown) => (error as { retryAfterMs?: number }).retryAfterMs === 2000,
  );
});

test("the turn retries transient HTTP failures up to maxAttempts, then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    retry: { maxAttempts: 3, baseDelayMs: 1, sleepImpl: async (ms) => { sleeps.push(ms); } },
    fetchImpl: (async () => {
      calls++;
      if (calls < 3) return new Response("upstream boom", { status: 502 });
      return new Response(
        JSON.stringify({ model: "wanted", choices: [{ message: { content: JSON.stringify({ tool_calls: [{ name: "finish" }] }) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
  const result = await turn(INPUT);
  assert.equal(result.attempts, 3, "three HTTP attempts reported");
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2, "backoff slept between attempts");
});

test("the turn does not retry a permanent 4xx", async () => {
  let calls = 0;
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    retry: { maxAttempts: 3, baseDelayMs: 1, sleepImpl: async () => {} },
    fetchImpl: (async () => {
      calls++;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => turn(INPUT), /HTTP 400/);
  assert.equal(calls, 1, "a 400 is not retried");
});

test("a retried 429 honours the Retry-After hint", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10_000, sleepImpl: async (ms) => { sleeps.push(ms); } },
    fetchImpl: (async () => {
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "2" } });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tool_calls: [{ name: "finish" }] }) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
  await turn(INPUT);
  assert.deepEqual(sleeps, [2000], "the server's window, not exponential backoff");
});

test("the turn does not retry a malformed reply; the attempt loop owns that", async () => {
  let calls = 0;
  const turn = createGatewayGymTurn({
    baseUrl: "http://gateway.test",
    model: "wanted",
    retry: { maxAttempts: 3, baseDelayMs: 1, sleepImpl: async () => {} },
    fetchImpl: fakeFetch({ body: { choices: [{ message: { content: "not json" } }] } }, () => { calls++; }),
  });
  await assert.rejects(() => turn(INPUT), /not JSON/);
  assert.equal(calls, 1, "malformed is re-asked by the loop, not retried as transient");
});

test("parseRetryAfterMs handles delta-seconds and rejects garbage", () => {
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "3" })), 3000);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "nonsense" })), undefined);
  assert.equal(parseRetryAfterMs(new Headers()), undefined);
});

test("the scripted turn computes substitution and calls finish when the script is exhausted", async () => {
  const turn = createScriptedGymTurn([{ toolCalls: [{ name: "run_visible_test" }] }], { requestedModel: "a", servedModel: "b" });
  const first = await turn(INPUT);
  assert.equal(first.modelSubstituted, true);
  assert.equal(first.toolCalls[0]?.name, "run_visible_test");
  const second = await turn({ ...INPUT, turnIndex: 1 });
  assert.equal(second.toolCalls[0]?.name, "finish");
});
