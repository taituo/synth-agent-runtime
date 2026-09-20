/**
 * Solidify the LiteLLM profile + router failover as a CI-run test, with the
 * control that makes the failover meaningful.
 *
 * Two healthy endpoints (distinct markers) and one down. The CONTROL profile
 * (healthy primary, healthy fallback) must be served by the PRIMARY with no
 * failure/cooldown; the FAILOVER profile (down primary) must be served by the
 * FALLBACK with the primary in cooldown.
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

function startEndpoint(behavior: "healthy" | "down", marker: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    if (behavior === "down") {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "litellm route is down" } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-litellm-upstream", marker);
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

test("a healthy primary is used; a down primary fails over and records cooldown", async () => {
  const healthyA = await startEndpoint("healthy", "primary-ok");
  const healthyB = await startEndpoint("healthy", "fallback-ok");
  const down = await startEndpoint("down", "down");
  const controlPrimary = litellmProfile({ id: "litellm/control-primary", baseUrl: healthyA.url, model: "cheap-model" });
  const controlFallback = litellmProfile({ id: "litellm/control-fallback", baseUrl: healthyB.url, model: "cheap-model" });
  const downPrimary = litellmProfile({ id: "litellm/cheap-down-primary", baseUrl: down.url, model: "cheap-model", cooldownMs: 30_000 });
  const failoverFallback = litellmProfile({ id: "litellm/cheap-fallback", baseUrl: healthyB.url, model: "cheap-model" });
  const controlProfile: GatewayProfile = {
    model: { id: "litellm/control", object: "model", provider: "litellm", profile: "litellm/control" },
    routes: [
      { id: "primary", backend: controlPrimary.backendName, model: "cheap-model" },
      { id: "fallback", backend: controlFallback.backendName, model: "cheap-model" },
    ],
  };
  const failoverProfile: GatewayProfile = {
    model: { id: "litellm/cheap", object: "model", provider: "litellm", profile: "litellm/cheap" },
    routes: [
      { id: "primary", backend: downPrimary.backendName, model: "cheap-model", cooldownMs: 30_000 },
      { id: "fallback", backend: failoverFallback.backendName, model: "cheap-model" },
    ],
  };
  const backends: Record<string, HttpGatewayBackend> = {
    [controlPrimary.backendName]: controlPrimary.backend as HttpGatewayBackend,
    [controlFallback.backendName]: controlFallback.backend as HttpGatewayBackend,
    [downPrimary.backendName]: downPrimary.backend as HttpGatewayBackend,
    [failoverFallback.backendName]: failoverFallback.backend as HttpGatewayBackend,
  };
  const router = new ProfileRouterBackend({ backends, profiles: [controlProfile, failoverProfile] });
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
    const control = await call("litellm/control");
    assert.equal(control.status, 200);
    assert.equal(control.servedBy, "primary-ok", "a healthy primary must serve, not the fallback");
    const controlHealth = router.inspect().health["litellm/control:primary"];
    assert.equal(controlHealth?.failures ?? 0, 0, "a healthy primary records no failure");

    const failover = await call("litellm/cheap");
    assert.equal(failover.status, 200);
    assert.equal(failover.servedBy, "fallback-ok", "the request must be served by the fallback route");
    const health = router.inspect().health["litellm/cheap:primary"];
    assert.ok((health?.failures ?? 0) >= 1, "the down primary must record the failure");
    assert.ok((health?.cooldownUntil ?? 0) > Date.now(), "the down primary must be in cooldown");
  } finally {
    await gateway.close();
    for (const endpoint of [healthyA, healthyB, down]) {
      await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
    }
  }
});
