/**
 * Track 5 unit tests: mixed-chain broker semantics that do not need a live
 * sandbox. The live script `integrations/kubernetes/mixed-chain.ts` proves the
 * shared-state question on the real rung; here a fake high-fidelity executor
 * exercises ordering, per-effect receipts and crash replay across the rung
 * boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionBroker, LocalRuntimeStateStore, MemoryWorkspace, SyntheticExecutor, } from "../src/index.js";
function trackingReal(order) {
    return {
        id: "fake-real",
        fidelity: 1,
        resourceClassId: "sandbox-small",
        canExecute: (effect) => effect.kind === "process.exec",
        execute: async (effect) => {
            order.push(effect.id);
            return { ok: true, output: { exitCode: 0 } };
        },
    };
}
function context(workspaceId) {
    return { agentId: "agt_mixed_unit", workspaceId };
}
test("mixed chain preserves effect order across the rung boundary", async () => {
    const workspace = new MemoryWorkspace();
    const order = [];
    const synthetic = new SyntheticExecutor(new Map([[workspace.id, workspace]]));
    const broker = new ExecutionBroker([synthetic, trackingReal(order)]);
    const ctx = context(workspace.id);
    const chain = [
        { id: "c1", kind: "workspace.write", path: "a.txt", content: "x" },
        { id: "c2", kind: "process.exec", command: "echo a" },
        { id: "c3", kind: "workspace.read", path: "a.txt" },
        { id: "c4", kind: "process.exec", command: "echo b" },
    ];
    const results = [];
    for (const effect of chain)
        results.push(await broker.execute(effect, ctx));
    assert.deepEqual(order, ["c2", "c4"], "the real rung ran the escalating effects in chain order");
    assert.deepEqual(results.map((result) => result.executor), ["synthetic", "fake-real", "synthetic", "fake-real"]);
});
test("a mixed chain records executor and fidelity per effect; overall is the lowest rung", async () => {
    const workspace = new MemoryWorkspace();
    const state = new LocalRuntimeStateStore();
    const synthetic = new SyntheticExecutor(new Map([[workspace.id, workspace]]));
    const broker = new ExecutionBroker([synthetic, trackingReal([])], state);
    const ctx = context(workspace.id);
    await broker.execute({ id: "r1", kind: "workspace.write", path: "a.txt", content: "x" }, ctx);
    await broker.execute({ id: "r2", kind: "process.exec", command: "echo a" }, ctx);
    const first = await state.getEffect("r1");
    const second = await state.getEffect("r2");
    assert.equal(first?.status, "committed");
    assert.equal((first?.result).executor, "synthetic");
    assert.equal((first?.result).fidelity, 0);
    assert.equal((second?.result).executor, "fake-real");
    assert.equal((second?.result).fidelity, 1);
    const overall = Math.min((first?.result).fidelity, (second?.result).fidelity);
    assert.equal(overall, 0, "a mixed chain's overall fidelity is the lowest rung any effect used");
});
test("crash replay across the boundary: committed effects replay, started stays uncertain", async () => {
    const workspace = new MemoryWorkspace();
    const state = new LocalRuntimeStateStore();
    const synthetic = new SyntheticExecutor(new Map([[workspace.id, workspace]]));
    const firstOrder = [];
    const firstBroker = new ExecutionBroker([synthetic, trackingReal(firstOrder)], state);
    const ctx = context(workspace.id);
    await firstBroker.execute({ id: "k1", kind: "workspace.write", path: "a.txt", content: "x" }, ctx);
    await firstBroker.execute({ id: "k2", kind: "process.exec", command: "echo a" }, ctx);
    assert.deepEqual(firstOrder, ["k2"]);
    // Simulate a crash: a fresh broker with the same durable state.
    const replayOrder = [];
    const replayBroker = new ExecutionBroker([synthetic, trackingReal(replayOrder)], state);
    const replayedWrite = await replayBroker.execute({ id: "k1", kind: "workspace.write", path: "a.txt", content: "x" }, ctx);
    const replayedExec = await replayBroker.execute({ id: "k2", kind: "process.exec", command: "echo a" }, ctx);
    assert.deepEqual(replayOrder, [], "committed effects are replayed, not re-run");
    assert.equal(replayedWrite.executor, "synthetic");
    assert.equal(replayedExec.executor, "fake-real");
    // An in-flight effect (started receipt) must stay uncertain, not be re-run.
    await state.putEffect({ id: "k3", kind: "process.exec", status: "started", startedAt: 1, updatedAt: 1 });
    const uncertain = await replayBroker.execute({ id: "k3", kind: "process.exec", command: "echo a" }, ctx);
    assert.equal(uncertain.ok, false);
    assert.equal(uncertain.error, "EFFECT_OUTCOME_UNCERTAIN:k3");
    assert.deepEqual(replayOrder, [], "an uncertain effect is never blindly repeated");
});
