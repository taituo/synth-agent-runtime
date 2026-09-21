import test from "node:test";
import assert from "node:assert/strict";
import { HttpGatewayBackend } from "../src/inference/gateway/http-upstream.js";

function capture(): { seen: () => string; fetch: typeof fetch } {
  let url = "";
  const fn = (async (input: unknown) => {
    url = String(input);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { seen: () => url, fetch: fn };
}

test("a base URL with a path prefix keeps that prefix when forwarding", async () => {
  const cap = capture();
  const backend = new HttpGatewayBackend({ baseUrl: "https://opencode.ai/zen", models: [], fetch: cap.fetch });
  await backend.handle(new Request("http://gw.test/v1/chat/completions", { method: "POST", body: "{}" }));
  assert.equal(cap.seen(), "https://opencode.ai/zen/v1/chat/completions");
});

test("a base URL with no path prefix still forwards to the root path", async () => {
  const cap = capture();
  const backend = new HttpGatewayBackend({ baseUrl: "http://127.0.0.1:8787", models: [], fetch: cap.fetch });
  await backend.handle(new Request("http://gw.test/v1/models"));
  assert.equal(cap.seen(), "http://127.0.0.1:8787/v1/models");
});
