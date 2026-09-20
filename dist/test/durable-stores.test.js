import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionBroker, InMemoryContinuationStore, InMemoryLeaseStore, InMemoryMailboxStore, LocalRuntimeStateStore, } from "../src/index.js";
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
test("stale command generation cannot overwrite committed higher fence", async () => {
    const state = new LocalRuntimeStateStore();
    await state.putCommand({ id: "c", status: "committed", startedAt: 1, updatedAt: 3, fencingToken: 5, result: "winner" });
    await state.putCommand({ id: "c", status: "started", startedAt: 1, updatedAt: 4, fencingToken: 4, error: "stale" });
    const record = await state.getCommand("c");
    assert.equal(record?.status, "committed");
    assert.equal(record?.result, "winner");
});
test("mailbox acknowledgement cannot skip beyond messages that exist", async () => {
    const mailbox = new InMemoryMailboxStore();
    const agentId = "a";
    await mailbox.appendMailbox(agentId, { id: "x", role: "human", text: "one", createdAt: 1 });
    const cursor = await mailbox.ackMailbox(agentId, "engine", 999);
    assert.equal(cursor.ackSeq, 1);
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
test("continuation store isolates tenant continuation ids", async () => {
    const store = new InMemoryContinuationStore();
    await store.putContinuation({ id: "r1", tenantId: "t1", value: { value: "secret" }, createdAt: Date.now(), expiresAt: Date.now() + 10000 });
    assert.equal((await store.getContinuation("r1", "t1"))?.value.value, "secret");
    assert.equal(await store.getContinuation("r1", "t2"), undefined);
    assert.equal(await store.getContinuation("r1"), undefined);
});
test("execution broker uses effect id as durable idempotency key", async () => {
    const state = new LocalRuntimeStateStore();
    let calls = 0;
    const executor = {
        id: "x",
        fidelity: 1,
        canExecute: () => true,
        async execute() { calls++; return { ok: true, output: { calls } }; },
    };
    const broker = new ExecutionBroker([executor], state);
    const effect = { id: "stable-effect", kind: "process.exec", command: "true" };
    const context = { agentId: "a", workspaceId: "w" };
    const first = await broker.execute(effect, context);
    const second = await broker.execute(effect, context);
    assert.equal(calls, 1);
    assert.deepEqual(second, first);
});
test("a fault after external execution leaves the effect uncertain and blocks replay", async () => {
    const state = new LocalRuntimeStateStore();
    let executions = 0;
    const executor = {
        id: "external",
        fidelity: 5,
        canExecute: () => true,
        async execute() { executions++; throw new Error("connection lost after the boundary"); },
    };
    const broker = new ExecutionBroker([executor], state);
    const effect = { id: "deploy-like", kind: "process.exec", command: "external-side-effect" };
    const context = { agentId: "a", workspaceId: "w" };
    await assert.rejects(broker.execute(effect, context), /connection lost/);
    assert.equal(executions, 1);
    const second = await broker.execute(effect, context);
    assert.equal(executions, 1, "a started receipt must not be blindly replayed");
    assert.equal(second.ok, false);
    assert.match(second.error ?? "", /EFFECT_OUTCOME_UNCERTAIN/);
});
