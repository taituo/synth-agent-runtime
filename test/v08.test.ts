import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentRuntime,
  CommandCoordinator,
  CompositeTenantPolicy,
  EffectReconciler,
  InMemoryContinuationStore,
  InMemoryLeaseStore,
  InMemoryMailboxStore,
  InMemoryRouterStateStore,
  InMemorySharedRateLimitStore,
  InMemoryTenantRateLimitPolicy,
  SharedTenantRateLimitPolicy,
  InMemoryWorldStore,
  LocalMemoryDurability,
  LocalRuntimeStateStore,
  MemoryWorkspace,
  ModelAclPolicy,
  ProfileRouterBackend,
  StaticBearerAuthenticator,
  createInferenceGateway,
  type Artifact,
  type Effect,
  type TaskSpec,
  type GatewayBackend,
  type GatewayModel,
} from "../src/index.js";

test("lease fencing token advances and stale owner cannot renew", async () => {
  let now = 1000;
  const leases = new InMemoryLeaseStore(() => now);
  const first = await leases.acquireLease("agent:a", "worker-1", 100, now);
  assert.equal(first.acquired, true);
  assert.equal(first.lease.fencingToken, 1);
  const blocked = await leases.acquireLease("agent:a", "worker-2", 100, now + 50);
  assert.equal(blocked.acquired, false);
  now = 1200;
  const second = await leases.acquireLease("agent:a", "worker-2", 100, now);
  assert.equal(second.acquired, true);
  assert.equal(second.lease.fencingToken, 2);
  assert.equal(await leases.renewLease("agent:a", "worker-1", 1, 100, now), undefined);
  assert.equal(await leases.releaseLease("agent:a", "worker-1", 1), false);
});

test("command coordinator requires reconciliation for abandoned started command", async () => {
  const state = new LocalRuntimeStateStore();
  const leases = new InMemoryLeaseStore();
  await state.putCommand({ id: "cmd", status: "started", startedAt: 1, updatedAt: 1, ownerId: "dead", fencingToken: 1, reconciliationRequired: true });
  const coordinator = new CommandCoordinator(state, leases, "worker-2", 1000);
  await assert.rejects(() => coordinator.run({ id: "cmd", async run() { return "bad"; } }), /COMMAND_RECONCILIATION_REQUIRED/);
  const value = await coordinator.run({
    id: "cmd",
    async reconcile() { return { status: "retry" } as const; },
    async run(_signal, fence) { assert.equal(fence, 2); return "ok"; },
  });
  assert.equal(value, "ok");
  assert.equal((await state.getCommand("cmd"))?.status, "committed");
});

test("command reconciliation is published under the current fencing generation", async () => {
  const state = new LocalRuntimeStateStore();
  const leases = new InMemoryLeaseStore();
  await state.putCommand({ id: "reconciled", status: "started", startedAt: 1, updatedAt: 1, ownerId: "dead", fencingToken: 4, reconciliationRequired: true });
  // Advance the lease generation to match the abandoned durable command generation.
  let now = 1;
  const first = await leases.acquireLease("command:reconciled", "dead", 1, now);
  assert.equal(first.lease.fencingToken, 1);
  now = 3;
  // Re-acquire/release a few generations to prove reconciliation stamps the active generation.
  for (let i = 0; i < 3; i++) {
    const c = await leases.acquireLease("command:reconciled", `old-${i}`, 1, now + i * 2);
    if (c.acquired) await leases.releaseLease("command:reconciled", c.lease.ownerId, c.lease.fencingToken);
  }
  const coordinator = new CommandCoordinator(state, leases, "worker-current", 1000);
  const value = await coordinator.run({
    id: "reconciled",
    async reconcile() { return { status: "committed", result: "already-done" } as const; },
    async run() { throw new Error("must not replay"); },
  });
  assert.equal(value, "already-done");
  const record = await state.getCommand("reconciled");
  assert.equal(record?.status, "committed");
  assert.equal(record?.ownerId, "worker-current");
  assert.ok((record?.fencingToken ?? 0) > 4);
  assert.equal(record?.reconciliationRequired, false);
});

test("stale command generation cannot overwrite committed higher fence", async () => {
  const state = new LocalRuntimeStateStore();
  await state.putCommand({ id: "c", status: "committed", startedAt: 1, updatedAt: 3, fencingToken: 5, result: "winner" });
  await state.putCommand({ id: "c", status: "started", startedAt: 1, updatedAt: 4, fencingToken: 4, error: "stale" });
  const record = await state.getCommand("c");
  assert.equal(record?.status, "committed");
  assert.equal(record?.result, "winner");
});

test("durable mailbox cursor only advances after successful agent run", async () => {
  const durability = new LocalMemoryDurability();
  const mailbox = new InMemoryMailboxStore();
  const runtime = new AgentRuntime(durability, undefined, new Map(), undefined, mailbox);
  const workspace = await runtime.createWorkspace(new MemoryWorkspace());
  const seen: string[][] = [];
  let shouldFail = true;
  const agent = await runtime.spawn({
    definition: { id: "mail", inferenceProfile: { id: "test" } },
    engine: { async run(messages) { seen.push(messages.map((m) => m.text)); if (shouldFail) throw new Error("fail once"); return "ok"; } },
    workspace,
  });
  await runtime.send(agent.id, "one", "human", undefined, "00000000-0000-4000-8000-000000000001");
  await runtime.send(agent.id, "two", "human", undefined, "00000000-0000-4000-8000-000000000002");
  await assert.rejects(() => runtime.run(agent.id), /fail once/);
  assert.equal((await mailbox.getMailboxCursor(agent.id, "engine"))?.ackSeq, undefined);
  shouldFail = false;
  // reset terminal test-state via a fresh runtime recovery-like spawn is unnecessary: run accepts failed snapshots.
  await runtime.run(agent.id);
  assert.deepEqual(seen, [["one", "two"], ["one", "two"]]);
  assert.equal((await mailbox.getMailboxCursor(agent.id, "engine"))?.ackSeq, 2);
});

test("mailbox acknowledgement cannot skip beyond messages that exist", async () => {
  const mailbox = new InMemoryMailboxStore();
  const agentId = "a" as any;
  await mailbox.appendMailbox(agentId, { id: "x", role: "human", text: "one", createdAt: 1 });
  const cursor = await mailbox.ackMailbox(agentId, "engine", 999);
  assert.equal(cursor.ackSeq, 1);
});

test("world compare-and-swap rejects stale concurrent project mutation", async () => {
  const world = new InMemoryWorldStore();
  const project = await world.createProject({ name: "p", objective: "ship" });
  const a = (await world.getProject(project.id))!;
  const b = (await world.getProject(project.id))!;
  a.objective = "A";
  const first = await world.compareAndSwapProject(a, a.revision);
  assert.equal(first.swapped, true);
  b.objective = "B";
  const stale = await world.compareAndSwapProject(b, b.revision);
  assert.equal(stale.swapped, false);
  assert.equal(stale.project.objective, "A");
  assert.equal(stale.project.revision, 1);
  await assert.rejects(() => world.putProject({ ...b, objective: "force stale" }), /WORLD_PUT_REQUIRES_NEWER_REVISION/);
});

test("world compare-and-swap rejects stale concurrent task and artifact mutation", async () => {
  const world = new InMemoryWorldStore();
  const task: TaskSpec = { id: "task-1" as any, title: "t", objective: "o", status: "pending" };
  await world.putTask(task);
  const a = (await world.getTask(task.id))!;
  const b = (await world.getTask(task.id))!;
  const first = await world.compareAndSwapTask!({ ...a, status: "running" }, a.revision ?? 0);
  assert.equal(first.swapped, true);
  assert.equal(first.task.revision, 1);
  const stale = await world.compareAndSwapTask!({ ...b, status: "completed" }, b.revision ?? 0);
  assert.equal(stale.swapped, false);
  assert.equal(stale.task.status, "running");
  assert.equal(stale.task.revision, 1);

  // An Artifact carries a REFERENCE, never inline bytes.
  const ref = (v: number) => ({ digest: `sha256:${String(v).padStart(64, "0")}`, size: v, mediaType: "text/plain", mechanism: "test" });
  const artifact: Artifact = { id: "art-1" as any, type: "report", createdAt: 1, ref: ref(1) };
  await world.putArtifact(artifact);
  const c = (await world.getArtifact(artifact.id))!;
  const d = (await world.getArtifact(artifact.id))!;
  const artifactFirst = await world.compareAndSwapArtifact!({ ...c, ref: ref(2) }, c.revision ?? 0);
  assert.equal(artifactFirst.swapped, true);
  assert.equal(artifactFirst.artifact.revision, 1);
  const artifactStale = await world.compareAndSwapArtifact!({ ...d, ref: ref(3) }, d.revision ?? 0);
  assert.equal(artifactStale.swapped, false);
  assert.equal(artifactStale.artifact.ref.size, 2);
  assert.equal(artifactStale.artifact.revision, 1);
});

test("effect reconciler resolves uncertain receipt without replay", async () => {
  const state = new LocalRuntimeStateStore();
  const effect: Effect = { id: "deploy-1", kind: "workflow.run", name: "deploy", input: {} };
  await state.putEffect({ id: effect.id, kind: effect.kind, status: "started", startedAt: 1, updatedAt: 1, error: "uncertain:connection lost" });
  let probes = 0;
  const reconciler = new EffectReconciler(state, [{
    supports(candidate) { return candidate.kind === "workflow.run"; },
    async reconcile() { probes++; return { status: "committed", result: { ok: true, output: { deploymentId: "d1" } } } as const; },
  }]);
  const result = await reconciler.reconcile(effect, { agentId: "a" as any, workspaceId: "w" as any });
  assert.equal(result.status, "committed");
  assert.equal(probes, 1);
  assert.equal((await state.getEffect(effect.id))?.status, "committed");
});

test("effect receipts are monotonic: a resolved receipt cannot be regressed", async () => {
  const state = new LocalRuntimeStateStore();
  await state.putEffect({ id: "e-regress", kind: "workflow.run", status: "started", startedAt: 1, updatedAt: 1 });
  await state.putEffect({ id: "e-regress", kind: "workflow.run", status: "committed", startedAt: 1, updatedAt: 2, result: { ok: true, output: "done" } });
  await state.putEffect({ id: "e-regress", kind: "workflow.run", status: "started", startedAt: 1, updatedAt: 3, error: "pending:x" });
  await state.putEffect({ id: "e-regress", kind: "workflow.run", status: "failed", startedAt: 1, updatedAt: 4, error: "boom" });
  const after = await state.getEffect("e-regress");
  assert.equal(after?.status, "committed");
  assert.deepEqual(after?.result, { ok: true, output: "done" });

  await state.putEffect({ id: "e-failed", kind: "workflow.run", status: "failed", startedAt: 1, updatedAt: 1, error: "boom" });
  await state.putEffect({ id: "e-failed", kind: "workflow.run", status: "started", startedAt: 1, updatedAt: 2, error: "pending:x" });
  assert.equal((await state.getEffect("e-failed"))?.status, "failed");
});

test("concurrent effect reconcilers cannot discard a committed resolution", async () => {
  const state = new LocalRuntimeStateStore();
  const effect: Effect = { id: "deploy-race", kind: "workflow.run", name: "deploy", input: {} };
  await state.putEffect({ id: effect.id, kind: effect.kind, status: "started", startedAt: 1, updatedAt: 1, error: "uncertain:connection lost" });

  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const slow = new EffectReconciler(state, [{
    supports: () => true,
    async reconcile() { await slowGate; return { status: "pending", detail: "probe timed out" } as const; },
  }]);
  const fast = new EffectReconciler(state, [{
    supports: () => true,
    async reconcile() { return { status: "committed", result: { ok: true, output: { deploymentId: "d1" } } } as const; },
  }]);

  const slowRun = slow.reconcile(effect, { agentId: "a" as any, workspaceId: "w" as any });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fastOutcome = await fast.reconcile(effect, { agentId: "a" as any, workspaceId: "w" as any });
  releaseSlow();
  const slowOutcome = await slowRun;

  assert.equal(fastOutcome.status, "committed");
  assert.equal(slowOutcome.status, "pending");
  const final = await state.getEffect(effect.id);
  assert.equal(final?.status, "committed", "a slow pending reconciler must not regress a committed receipt");
  assert.deepEqual(final?.result, { ok: true, output: { deploymentId: "d1" } });
});

test("event retention watermark is the slowest registered consumer", async () => {
  const durability = new LocalMemoryDurability();
  for (let i = 0; i < 5; i++) {
    await durability.appendEvent({ type: "agent.created", agent: { id: `a${i}` } as any, at: i } as any);
  }
  assert.equal(await durability.safeEventWatermark!(), 0, "no consumers must fail closed");
  await durability.ackEvent!("c1", 3);
  await durability.ackEvent!("c2", 5);
  assert.equal(await durability.safeEventWatermark!(), 3);

  // Acks are monotonic and clamped to the current max sequence.
  assert.equal((await durability.ackEvent!("c1", 1)).ackSeq, 3);
  assert.equal((await durability.ackEvent!("c1", 99)).ackSeq, 5);
  assert.equal(await durability.safeEventWatermark!(), 5);

  // A lagging consumer holds retention back; forgetting it raises the watermark.
  await durability.ackEvent!("c3", 1);
  assert.equal(await durability.safeEventWatermark!(), 1);
  assert.equal(await durability.forgetEventConsumer!("c3"), true);
  assert.equal(await durability.safeEventWatermark!(), 5);

  // Safe pruning removes exactly the acked prefix.
  assert.equal(await durability.pruneEventsSafe!(), 5);
  assert.deepEqual((await durability.readEvents!()).map((e) => e.seq), []);
});

test("pruneEventsSafe never removes events with no registered consumer", async () => {
  const durability = new LocalMemoryDurability();
  await durability.appendEvent({ type: "agent.created", agent: { id: "a" } as any, at: 1 } as any);
  assert.equal(await durability.pruneEventsSafe!(), 0);
  assert.equal((await durability.readEvents!()).length, 1);
});

test("continuation store isolates tenant continuation ids", async () => {
  const store = new InMemoryContinuationStore<{ value: string }>();
  await store.putContinuation({ id: "r1", tenantId: "t1", value: { value: "secret" }, createdAt: Date.now(), expiresAt: Date.now() + 10000 });
  assert.equal((await store.getContinuation("r1", "t1"))?.value.value, "secret");
  assert.equal(await store.getContinuation("r1", "t2"), undefined);
  assert.equal(await store.getContinuation("r1"), undefined);
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

test("durability event cursors resume and retention prunes old events", async () => {
  const durability = new LocalMemoryDurability();
  await durability.appendEvent({ type: "agent.output", agentId: "a" as any, text: "1", at: 1 });
  await durability.appendEvent({ type: "agent.output", agentId: "a" as any, text: "2", at: 2 });
  await durability.appendEvent({ type: "agent.output", agentId: "a" as any, text: "3", at: 3 });
  const tail = await durability.readEvents!({ afterSeq: 1, limit: 10 });
  assert.deepEqual(tail.map((e) => e.seq), [2, 3]);
  assert.equal(await durability.pruneEvents!(2), 2);
  assert.deepEqual((await durability.readEvents!()).map((e) => e.seq), [3]);
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
