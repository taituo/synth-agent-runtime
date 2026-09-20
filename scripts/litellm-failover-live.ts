/**
 * LIVE proof: a LiteLLM profile behind ProfileRouterBackend, and failover.
 *
 * Two real OpenAI-compatible HTTP endpoints are started: one healthy, one
 * returning 503 (the LiteLLM route is down). A single profile has two routes —
 * the failing LiteLLM endpoint first, the healthy one as fallback — and the
 * request goes through the real gateway and the real ProfileRouterBackend.
 *
 * Asserts the discriminating things: the response is 200 and came from the
 * FALLBACK endpoint (an `x-litellm-upstream: healthy` marker), the primary
 * route recorded a failure and is in cooldown, and a second profile with only
 * the healthy route serves directly. This proves the router's failover and
 * cooldown; it does NOT prove a real LiteLLM instance answered. Set LITELLM_URL
 * (and LITELLM_MODEL) to also route a profile at a real LiteLLM.
 *
 * Run: integrations/temporal/node_modules/.bin/tsx scripts/litellm-failover-live.ts
 */
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createInferenceGateway,
  HttpGatewayBackend,
  litellmProfile,
  ProfileRouterBackend,
  type GatewayProfile,
} from "../src/index.js";

function chatBody(model: string): string {
  return JSON.stringify({
    id: `chatcmpl-${model}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function startEndpoint(behavior: "healthy" | "down"): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (behavior === "down") {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "litellm route is down" } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-litellm-upstream", "healthy");
    res.end(chatBody("cheap-model"));
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

async function main(): Promise<void> {
  const healthy = await startEndpoint("healthy");
  const down = await startEndpoint("down");
  const realLiteLlmUrl = process.env.LITELLM_URL;
  const realLiteLlmModel = process.env.LITELLM_MODEL ?? "gpt-4o-mini";

  // Distinct backend ids, or the second entry would overwrite the first in the
  // backend map and both routes would hit the healthy endpoint.
  const primary = litellmProfile({ id: "litellm/cheap-primary", baseUrl: down.url, model: "cheap-model", cooldownMs: 30_000 });
  const fallback = litellmProfile({ id: "litellm/cheap-fallback", baseUrl: healthy.url, model: "cheap-model" });
  const healthyOnly = litellmProfile({ id: "litellm/healthy", baseUrl: healthy.url, model: "cheap-model" });

  // Two routes in one profile: the down LiteLLM endpoint first, healthy second.
  const failoverProfile: GatewayProfile = {
    model: { id: "litellm/cheap", object: "model", owned_by: "synth-router", provider: "litellm", profile: "litellm/cheap" },
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
  const profiles = [failoverProfile, healthyOnly.profile];

  if (realLiteLlmUrl) {
    const real = litellmProfile({ id: "litellm/real", baseUrl: realLiteLlmUrl, model: realLiteLlmModel, ...(process.env.LITELLM_API_KEY ? { apiKey: process.env.LITELLM_API_KEY } : {}) });
    backends[real.backendName] = real.backend as HttpGatewayBackend;
    profiles.push(real.profile);
  }

  const router = new ProfileRouterBackend({ backends, profiles });
  const gateway = createInferenceGateway({ backend: router, port: 0 });
  await gateway.listen();

  const call = async (model: string): Promise<{ status: number; servedBy: string | null; body: string }> => {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 4 }),
    });
    return { status: response.status, servedBy: response.headers.get("x-litellm-upstream"), body: (await response.text()).slice(0, 200) };
  };

  const failover = await call("litellm/cheap");
  const direct = await call("litellm/healthy");
  const real = realLiteLlmUrl ? await call("litellm/real") : undefined;

  const health = router.inspect().health;
  const primaryHealth = health["litellm/cheap:primary"];
  const failoverOk =
    failover.status === 200 &&
    failover.servedBy === "healthy" &&
    (primaryHealth?.failures ?? 0) >= 1 &&
    (primaryHealth?.cooldownUntil ?? 0) > Date.now();
  const directOk = direct.status === 200 && direct.servedBy === "healthy";
  const realOk = real === undefined ? null : real.status === 200;
  const ok = failoverOk && directOk && (realOk ?? true);

  console.log(
    JSON.stringify(
      {
        mode: realLiteLlmUrl ? "local + real litellm" : "local openai-compatible endpoints (set LITELLM_URL for a real LiteLLM)",
        gateway: gateway.url,
        failover: { status: failover.status, servedBy: failover.servedBy, primaryFailures: primaryHealth?.failures ?? 0, primaryCooldownUntil: primaryHealth?.cooldownUntil ?? 0 },
        routeHealth: Object.fromEntries(Object.entries(health).map(([key, value]) => [key, { failures: value.failures, successes: value.successes, lastStatus: value.lastStatus, cooldownUntil: value.cooldownUntil }])),
        directProfile: { status: direct.status, servedBy: direct.servedBy },
        realLiteLlm: real ? { status: real.status, body: real.body } : null,
        failoverOk,
        directOk,
        realOk,
        ok,
      },
      null,
      2,
    ),
  );

  await gateway.close();
  await new Promise<void>((resolve) => healthy.server.close(() => resolve()));
  await new Promise<void>((resolve) => down.server.close(() => resolve()));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
