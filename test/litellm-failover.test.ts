/**
 * Solidify the LiteLLM profile + router failover as a CI-run test.
 *
 * `scripts/litellm-failover-live.ts` proves this by hand; this pins the same
 * behaviour in the suite using real local HTTP endpoints (one 503, one
 * healthy), the real ProfileRouterBackend and the real gateway server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  createInferenceGateway,
  HttpGatewayBackend,
  litellmProfile,
  ProfileRouterBackend,
  type GatewayProfile,
} from "../src/index.js";

function startEndpoint(behavior: "healthy" | "down"): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    if (behavior === "down") {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "litellm route is down" } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-litellm-upstream", "healthy");
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "cheap-model",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("a LiteLLM profile fails over from a down route and records the cooldown", async () => {
  const healthy = await startEndpoint("healthy");
  const down = await startEndpoint("down");
  const primary = litellmProfile({ id: "litellm/cheap-primary", baseUrl: down.url, model: "cheap-model", cooldownMs: 30_000 });
  const fallback = litellmProfile({ id: "litellm/cheap-fallback", baseUrl: healthy.url, model: "cheap-model" });
  const healthyOnly = litellmProfile({ id: "litellm/healthy", baseUrl: healthy.url, model: "cheap-model" });
  const failoverProfile: GatewayProfile = {
    model: { id: "litellm/cheap", object: "model", provider: "litellm", profile: "litellm/cheap" },
    routes: [
      { id: "primary", backend: primary.backendName, model: "cheap-model", cooldownMs: 30_000 },
      { id: "fallback", backend: fallback.backendName, model: "cheap-model" },
    ],
  };
  const backends: Record<string, HttpGatewayBackend> = {
    [primary.backendName]: primary.backend as HttpGatewayBackend,
    [fallback.backendName]: fallback.backend as HttpGatewayBackend,
    [healthyOnly.backendName]: healthyOnly.backend as HttpGatewayBackend,
  };
  const router = new ProfileRouterBackend({ backends, profiles: [failoverProfile, healthyOnly.profile] });
  const gateway = createInferenceGateway({ backend: router, port: 0 });
  await gateway.listen();

  const call = async (model: string) => {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 4 }),
    });
    return { status: response.status, servedBy: response.headers.get("x-litellm-upstream") };
  };

  try {
    const failover = await call("litellm/cheap");
    assert.equal(failover.status, 200);
    assert.equal(failover.servedBy, "healthy", "the request must be served by the fallback route");
    const health = router.inspect().health["litellm/cheap:primary"];
    assert.ok((health?.failures ?? 0) >= 1, "the primary route must record the failure");
    assert.ok((health?.cooldownUntil ?? 0) > Date.now(), "the primary route must be in cooldown");

    const direct = await call("litellm/healthy");
    assert.equal(direct.status, 200);
    assert.equal(direct.servedBy, "healthy");
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => healthy.server.close(() => resolve()));
    await new Promise<void>((resolve) => down.server.close(() => resolve()));
  }
});
