import test from "node:test";
import assert from "node:assert/strict";
import {
  CompositeTenantPolicy,
  InMemoryRouterStateStore,
  InMemorySharedRateLimitStore,
  InMemoryTenantRateLimitPolicy,
  ModelAclPolicy,
  ProfileRouterBackend,
  SharedTenantRateLimitPolicy,
  StaticBearerAuthenticator,
  createInferenceGateway,
  type GatewayBackend,
  type GatewayModel,
} from "../src/index.js";

test("profile router rewrites virtual model and falls back on 429", async () => {
  const seen: Array<[string, string]> = [];
  const backend = (name: string, status: number): GatewayBackend => ({
    async listModels() { return []; },
    async handle(request, model) {
      const body = await request.json() as { model: string };
      seen.push([name, body.model]);
      return new Response(JSON.stringify({ name }), { status, headers: { "content-type": "application/json" } });
    },
  });
  const router = new ProfileRouterBackend({
    backends: { first: backend("first", 429), second: backend("second", 200) },
    profiles: [{ model: { id: "worker/cheap" }, routes: [
      { id: "r1", backend: "first", model: "go-model" },
      { id: "r2", backend: "second", model: "fallback-model" },
    ] }],
  });
  const response = await router.handle(new Request("http://router/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "worker/cheap", messages: [] }),
  }), "worker/cheap");
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [["first", "go-model"], ["second", "fallback-model"]]);
});

test("gateway keeps session affinity after fallback", async () => {
  const seen: string[] = [];
  let firstCalls = 0;
  const backend = (name: string, fn: () => number): GatewayBackend => ({
    async listModels() { return []; },
    async handle() { seen.push(name); return new Response("{}", { status: fn() }); },
  });
  const router = new ProfileRouterBackend({
    backends: {
      first: backend("first", () => (++firstCalls === 1 ? 429 : 200)),
      second: backend("second", () => 200),
    },
    profiles: [{ model: { id: "worker" }, routes: [
      { id: "r1", backend: "first" },
      { id: "r2", backend: "second" },
    ] }],
  });
  const request = () => new Request("http://router/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-synth-session": "s1" },
    body: JSON.stringify({ model: "worker", input: "x" }),
  });
  assert.equal((await router.handle(request(), "worker")).status, 200);
  assert.equal((await router.handle(request(), "worker")).status, 200);
  assert.deepEqual(seen, ["first", "second", "second"]);
});

test("router affinity and cooldown are shared across router replicas", async () => {
  const shared = new InMemoryRouterStateStore();
  let aCalls = 0;
  let bCalls = 0;
  const backendA: GatewayBackend = { async listModels() { return []; }, async handle() { aCalls++; return new Response("busy", { status: 429 }); } };
  const backendB: GatewayBackend = { async listModels() { return []; }, async handle() { bCalls++; return new Response("ok", { status: 200 }); } };
  const profile = { model: { id: "virtual" } as GatewayModel, routes: [{ id: "a", backend: "a", cooldownMs: 10000 }, { id: "b", backend: "b" }] };
  const router1 = new ProfileRouterBackend({ backends: { a: backendA, b: backendB }, profiles: [profile], state: shared, now: () => 1000 });
  const req = () => new Request("http://x/v1/responses", { method: "POST", headers: { "x-synth-session": "s1", "content-type": "application/json" }, body: JSON.stringify({ model: "virtual", input: "hi" }) });
  assert.equal((await router1.handle(req(), "virtual")).status, 200);
  const router2 = new ProfileRouterBackend({ backends: { a: backendA, b: backendB }, profiles: [profile], state: shared, now: () => 1001 });
  assert.equal((await router2.handle(req(), "virtual")).status, 200);
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 2);
});

test("router affinity key is tenant-scoped even when session ids collide", async () => {
  const shared = new InMemoryRouterStateStore();
  await shared.putAffinity("tenant-a:virtual:same", "b", Date.now() + 10000);
  const calls: string[] = [];
  const a: GatewayBackend = { async listModels() { return []; }, async handle() { calls.push("a"); return new Response("ok"); } };
  const b: GatewayBackend = { async listModels() { return []; }, async handle() { calls.push("b"); return new Response("ok"); } };
  const router = new ProfileRouterBackend({ backends: { a, b }, profiles: [{ model: { id: "virtual" }, routes: [{ id: "a", backend: "a" }, { id: "b", backend: "b" }] }], state: shared });
  const request = (tenant: string) => new Request("http://x/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-synth-tenant": tenant, "x-synth-session": "same" }, body: JSON.stringify({ model: "virtual" }) });
  await router.handle(request("tenant-a"), "virtual");
  await router.handle(request("tenant-b"), "virtual");
  assert.deepEqual(calls, ["b", "a"]);
});

test("static bearer authenticator compares tokens safely across lengths", () => {
  const auth = new StaticBearerAuthenticator({
    "secret-token-value": { tenantId: "t1", subject: "u1" },
    short: { tenantId: "t2", subject: "u2" },
  });
  const request = (token: string) => new Request("http://gateway/v1/models", { headers: { authorization: `Bearer ${token}` } });

  assert.equal(auth.authenticate(request("secret-token-value"))?.tenantId, "t1");
  assert.equal(auth.authenticate(request("short"))?.tenantId, "t2");
  // Same length, wrong token.
  assert.equal(auth.authenticate(request("secret-token-valuX")), undefined);
  // Different lengths must return undefined rather than throw (timingSafeEqual
  // requires equal-length inputs; the digest step makes them fixed-length).
  assert.equal(auth.authenticate(request("x")), undefined);
  assert.equal(auth.authenticate(request("secret-token-value-and-then-some")), undefined);
  // Missing / wrong scheme.
  assert.equal(auth.authenticate(new Request("http://gateway/v1/models")), undefined);
  assert.equal(auth.authenticate(new Request("http://gateway/v1/models", { headers: { authorization: "Basic secret-token-value" } })), undefined);
});

test("gateway enforces bearer auth, model ACL and tenant rate limit", async () => {
  const backend: GatewayBackend = {
    async listModels() { return [{ id: "allowed" }]; },
    async handle(request, model) { return new Response(JSON.stringify({ model, tenant: request.headers.get("x-synth-tenant") }), { headers: { "content-type": "application/json" } }); },
  };
  const gateway = createInferenceGateway({
    backend,
    port: 0,
    authenticator: new StaticBearerAuthenticator({ token: { tenantId: "t1", subject: "u1", allowedModels: ["allowed"], requestsPerMinute: 1 } }),
    tenantPolicy: new CompositeTenantPolicy([new ModelAclPolicy(), new InMemoryTenantRateLimitPolicy(() => 0)]),
  });
  await gateway.listen();
  try {
    assert.equal((await fetch(`${gateway.url}/v1/models`)).status, 401);
    const listed = await fetch(`${gateway.url}/v1/models`, { headers: { authorization: "Bearer token" } });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as any).data.map((m: any) => m.id), ["allowed"]);
    const post = (model: string, token?: string) => fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ model, input: "hi" }) });
    assert.equal((await post("allowed")).status, 401);
    assert.equal((await post("denied", "token")).status, 403);
    const ok = await post("allowed", "token");
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as any).tenant, "t1");
    assert.equal((await post("allowed", "token")).status, 429);
  } finally { await gateway.close(); }
});

test("shared tenant rate limiting enforces one global limit across replicas", async () => {
  const store = new InMemorySharedRateLimitStore();
  const replicaA = new SharedTenantRateLimitPolicy(store, 60_000, () => 0);
  const replicaB = new SharedTenantRateLimitPolicy(store, 60_000, () => 0);
  const principal = { tenantId: "t-shared", subject: "u", requestsPerMinute: 3 };
  const attempt = async (policy: SharedTenantRateLimitPolicy) => {
    try { await policy.authorize(principal); return "ok"; } catch (error) { return (error as Error).message; }
  };
  const results = [
    await attempt(replicaA), await attempt(replicaB), await attempt(replicaA),
    await attempt(replicaB), await attempt(replicaA),
  ];
  assert.deepEqual(results, ["ok", "ok", "ok", "RATE_LIMITED:t-shared", "RATE_LIMITED:t-shared"]);

  // The per-process policy allows the full limit per instance, so N replicas
  // permit up to N x the configured limit — the reason the shared policy exists.
  const perProcessA = new InMemoryTenantRateLimitPolicy(() => 0);
  const perProcessB = new InMemoryTenantRateLimitPolicy(() => 0);
  let allowed = 0;
  for (const policy of [perProcessA, perProcessB, perProcessA, perProcessB, perProcessA]) {
    try { policy.authorize(principal, "m"); allowed++; } catch { /* limited */ }
  }
  assert.ok(allowed > principal.requestsPerMinute, `two replicas allowed ${allowed} > limit ${principal.requestsPerMinute}`);
});
