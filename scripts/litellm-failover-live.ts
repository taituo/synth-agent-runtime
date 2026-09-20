/**
 * LIVE proof: a LiteLLM profile behind ProfileRouterBackend, with a CONTROL.
 *
 * Three real OpenAI-compatible HTTP endpoints are started: two healthy (each
 * with a distinct `x-litellm-upstream` marker) and one returning 503. Two
 * profiles are built:
 *   - CONTROL: primary -> healthy-A, fallback -> healthy-B. A request must be
 *     served by the PRIMARY, with no failure and no cooldown. This is what
 *     proves the failover below is a real event, not the router always using
 *     the fallback.
 *   - FAILOVER: primary -> down, fallback -> healthy-B. A request must be
 *     served by the FALLBACK, with the primary recording a failure and entering
 *     cooldown.
 *
 * It does NOT prove a real LiteLLM instance answered. Set LITELLM_URL (and
 * LITELLM_MODEL) to also route a profile at a real LiteLLM.
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
  const healthyA = await startEndpoint("healthy", "primary-ok");
  const healthyB = await startEndpoint("healthy", "fallback-ok");
  const down = await startEndpoint("down", "down");
  const realLiteLlmUrl = process.env.LITELLM_URL;
  const realLiteLlmModel = process.env.LITELLM_MODEL ?? "gpt-4o-mini";

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
  const profiles = [controlProfile, failoverProfile];

  if (realLiteLlmUrl) {
    const real = litellmProfile({ id: "litellm/real", baseUrl: realLiteLlmUrl, model: realLiteLlmModel, ...(process.env.LITELLM_API_KEY ? { apiKey: process.env.LITELLM_API_KEY } : {}) });
    backends[real.backendName] = real.backend as HttpGatewayBackend;
    profiles.push(real.profile);
  }

  const router = new ProfileRouterBackend({ backends, profiles });
  const gateway = createInferenceGateway({ backend: router, port: 0 });
  await gateway.listen();

  const call = async (model: string): Promise<{ status: number; servedBy: string | null }> => {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 4 }),
    });
    return { status: response.status, servedBy: response.headers.get("x-litellm-upstream") };
  };

  const control = await call("litellm/control");
  const controlHealth = router.inspect().health["litellm/control:primary"];
  const controlOk =
    control.status === 200 &&
    control.servedBy === "primary-ok" &&
    (controlHealth?.failures ?? 0) === 0 &&
    (controlHealth?.cooldownUntil ?? 0) === 0;

  const failover = await call("litellm/cheap");
  const failoverHealth = router.inspect().health["litellm/cheap:primary"];
  const failoverOk =
    failover.status === 200 &&
    failover.servedBy === "fallback-ok" &&
    (failoverHealth?.failures ?? 0) >= 1 &&
    (failoverHealth?.cooldownUntil ?? 0) > Date.now();

  const real = realLiteLlmUrl ? await call("litellm/real") : undefined;
  const realOk = real === undefined ? null : real.status === 200;
  const ok = controlOk && failoverOk && (realOk ?? true);

  console.log(
    JSON.stringify(
      {
        mode: realLiteLlmUrl ? "local + real litellm" : "local openai-compatible endpoints (set LITELLM_URL for a real LiteLLM)",
        gateway: gateway.url,
        control: {
          status: control.status,
          servedBy: control.servedBy,
          primaryFailures: controlHealth?.failures ?? 0,
          primaryCooldownUntil: controlHealth?.cooldownUntil ?? 0,
        },
        failover: {
          status: failover.status,
          servedBy: failover.servedBy,
          primaryFailures: failoverHealth?.failures ?? 0,
          primaryCooldownUntil: failoverHealth?.cooldownUntil ?? 0,
        },
        realLiteLlm: real ? { status: real.status } : null,
        controlOk,
        failoverOk,
        realOk,
        ok,
      },
      null,
      2,
    ),
  );

  await gateway.close();
  for (const endpoint of [healthyA, healthyB, down]) {
    await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
