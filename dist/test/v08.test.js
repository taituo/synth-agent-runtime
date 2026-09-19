import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, CommandCoordinator, CompositeTenantPolicy, EffectReconciler, InMemoryContinuationStore, InMemoryLeaseStore, InMemoryMailboxStore, InMemoryRouterStateStore, InMemoryTenantRateLimitPolicy, InMemoryWorldStore, LocalMemoryDurability, LocalRuntimeStateStore, MemoryWorkspace, ModelAclPolicy, ProfileRouterBackend, StaticBearerAuthenticator, createInferenceGateway, } from "../src/index.js";
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
        async reconcile() { return { status: "retry" }; },
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
        if (c.acquired)
            await leases.releaseLease("command:reconciled", c.lease.ownerId, c.lease.fencingToken);
    }
    const coordinator = new CommandCoordinator(state, leases, "worker-current", 1000);
    const value = await coordinator.run({
        id: "reconciled",
        async reconcile() { return { status: "committed", result: "already-done" }; },
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
    const seen = [];
    let shouldFail = true;
    const agent = await runtime.spawn({
        definition: { id: "mail", inferenceProfile: { id: "test" } },
        engine: { async run(messages) { seen.push(messages.map((m) => m.text)); if (shouldFail)
                throw new Error("fail once"); return "ok"; } },
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
    const agentId = "a";
    await mailbox.appendMailbox(agentId, { id: "x", role: "human", text: "one", createdAt: 1 });
    const cursor = await mailbox.ackMailbox(agentId, "engine", 999);
    assert.equal(cursor.ackSeq, 1);
});
test("world compare-and-swap rejects stale concurrent project mutation", async () => {
    const world = new InMemoryWorldStore();
    const project = await world.createProject({ name: "p", objective: "ship" });
    const a = (await world.getProject(project.id));
    const b = (await world.getProject(project.id));
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
test("effect reconciler resolves uncertain receipt without replay", async () => {
    const state = new LocalRuntimeStateStore();
    const effect = { id: "deploy-1", kind: "workflow.run", name: "deploy", input: {} };
    await state.putEffect({ id: effect.id, kind: effect.kind, status: "started", startedAt: 1, updatedAt: 1, error: "uncertain:connection lost" });
    let probes = 0;
    const reconciler = new EffectReconciler(state, [{
            supports(candidate) { return candidate.kind === "workflow.run"; },
            async reconcile() { probes++; return { status: "committed", result: { ok: true, output: { deploymentId: "d1" } } }; },
        }]);
    const result = await reconciler.reconcile(effect, { agentId: "a", workspaceId: "w" });
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
    const effect = { id: "deploy-race", kind: "workflow.run", name: "deploy", input: {} };
    await state.putEffect({ id: effect.id, kind: effect.kind, status: "started", startedAt: 1, updatedAt: 1, error: "uncertain:connection lost" });
    let releaseSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const slow = new EffectReconciler(state, [{
            supports: () => true,
            async reconcile() { await slowGate; return { status: "pending", detail: "probe timed out" }; },
        }]);
    const fast = new EffectReconciler(state, [{
            supports: () => true,
            async reconcile() { return { status: "committed", result: { ok: true, output: { deploymentId: "d1" } } }; },
        }]);
    const slowRun = slow.reconcile(effect, { agentId: "a", workspaceId: "w" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fastOutcome = await fast.reconcile(effect, { agentId: "a", workspaceId: "w" });
    releaseSlow();
    const slowOutcome = await slowRun;
    assert.equal(fastOutcome.status, "committed");
    assert.equal(slowOutcome.status, "pending");
    const final = await state.getEffect(effect.id);
    assert.equal(final?.status, "committed", "a slow pending reconciler must not regress a committed receipt");
    assert.deepEqual(final?.result, { ok: true, output: { deploymentId: "d1" } });
});
test("continuation store isolates tenant continuation ids", async () => {
    const store = new InMemoryContinuationStore();
    await store.putContinuation({ id: "r1", tenantId: "t1", value: { value: "secret" }, createdAt: Date.now(), expiresAt: Date.now() + 10000 });
    assert.equal((await store.getContinuation("r1", "t1"))?.value.value, "secret");
    assert.equal(await store.getContinuation("r1", "t2"), undefined);
    assert.equal(await store.getContinuation("r1"), undefined);
});
test("router affinity and cooldown are shared across router replicas", async () => {
    const shared = new InMemoryRouterStateStore();
    let aCalls = 0;
    let bCalls = 0;
    const backendA = { async listModels() { return []; }, async handle() { aCalls++; return new Response("busy", { status: 429 }); } };
    const backendB = { async listModels() { return []; }, async handle() { bCalls++; return new Response("ok", { status: 200 }); } };
    const profile = { model: { id: "virtual" }, routes: [{ id: "a", backend: "a", cooldownMs: 10000 }, { id: "b", backend: "b" }] };
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
    const calls = [];
    const a = { async listModels() { return []; }, async handle() { calls.push("a"); return new Response("ok"); } };
    const b = { async listModels() { return []; }, async handle() { calls.push("b"); return new Response("ok"); } };
    const router = new ProfileRouterBackend({ backends: { a, b }, profiles: [{ model: { id: "virtual" }, routes: [{ id: "a", backend: "a" }, { id: "b", backend: "b" }] }], state: shared });
    const request = (tenant) => new Request("http://x/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-synth-tenant": tenant, "x-synth-session": "same" }, body: JSON.stringify({ model: "virtual" }) });
    await router.handle(request("tenant-a"), "virtual");
    await router.handle(request("tenant-b"), "virtual");
    assert.deepEqual(calls, ["b", "a"]);
});
test("durability event cursors resume and retention prunes old events", async () => {
    const durability = new LocalMemoryDurability();
    await durability.appendEvent({ type: "agent.output", agentId: "a", text: "1", at: 1 });
    await durability.appendEvent({ type: "agent.output", agentId: "a", text: "2", at: 2 });
    await durability.appendEvent({ type: "agent.output", agentId: "a", text: "3", at: 3 });
    const tail = await durability.readEvents({ afterSeq: 1, limit: 10 });
    assert.deepEqual(tail.map((e) => e.seq), [2, 3]);
    assert.equal(await durability.pruneEvents(2), 2);
    assert.deepEqual((await durability.readEvents()).map((e) => e.seq), [3]);
});
test("gateway enforces bearer auth, model ACL and tenant rate limit", async () => {
    const backend = {
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
        assert.deepEqual((await listed.json()).data.map((m) => m.id), ["allowed"]);
        const post = (model, token) => fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ model, input: "hi" }) });
        assert.equal((await post("allowed")).status, 401);
        assert.equal((await post("denied", "token")).status, 403);
        const ok = await post("allowed", "token");
        assert.equal(ok.status, 200);
        assert.equal((await ok.json()).tenant, "t1");
        assert.equal((await post("allowed", "token")).status, 429);
    }
    finally {
        await gateway.close();
    }
});
