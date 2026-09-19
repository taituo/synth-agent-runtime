import test from "node:test";
import assert from "node:assert/strict";
import { ChaosController, ChaosDurabilityProvider, ChaosExecutor, ExecutionBroker, LocalMemoryDurability, LocalRuntimeStateStore, persistAgentSnapshot, runCrashRecoveryScenario, } from "../src/index.js";
test("chaos failpoints are deterministic", () => {
    const chaos = new ChaosController([{ point: "x", nth: 2 }]);
    chaos.hit("x");
    assert.throws(() => chaos.hit("x"), /Injected chaos fault/);
    chaos.hit("x");
    assert.deepEqual(chaos.history().map((x) => x.fired), [false, true, false]);
});
test("crash recovery scenario restores pre-turn world", async () => {
    const result = await runCrashRecoveryScenario();
    assert.equal(result.dirty, "dirty-after-crash");
    assert.equal(result.recovered, result.before);
    assert.equal(result.rolledBack, 1);
});
test("chaos durability forwards the optional fenced/event surface only when present", async () => {
    const chaos = new ChaosController([]);
    const wrapped = new ChaosDurabilityProvider(new LocalMemoryDurability(), chaos);
    assert.equal(typeof wrapped.putAgentFenced, "function");
    assert.equal(typeof wrapped.readEvents, "function");
    assert.equal(typeof wrapped.pruneEvents, "function");
    const agent = {
        id: "agent-1", definitionId: "d", workspaceId: "w", state: "idle",
        createdAt: 1, updatedAt: 1, mailbox: [], metadata: {},
    };
    const fence = { resourceId: "agent:agent-1", ownerId: "owner", fencingToken: 2 };
    await wrapped.createAgent(agent);
    assert.equal(await wrapped.putAgentFenced(agent, fence), true);
    assert.equal(await wrapped.putAgentFenced(agent, { ...fence, fencingToken: 1 }), false);
    await persistAgentSnapshot(wrapped, agent, fence);
    await wrapped.appendEvent({ type: "agent.created", agent, at: 1 });
    const events = await wrapped.readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, 1);
    await wrapped.ackEvent("consumer-1", 1);
    assert.equal((await wrapped.getEventCursor("consumer-1"))?.ackSeq, 1);
    assert.equal(await wrapped.safeEventWatermark(), 1);
    assert.equal((await wrapped.listEventCursors()).length, 1);
    assert.equal(await wrapped.pruneEventsSafe(), 1);
    assert.equal(await wrapped.forgetEventConsumer("consumer-1"), true);
    assert.equal(await wrapped.pruneEvents(0), 0);
    assert.equal((await wrapped.readEvents()).length, 0);
    for (const point of [
        "durability.putAgentFenced.before",
        "durability.readEvents.before",
        "durability.pruneEvents.before",
        "durability.ackEvent.before",
        "durability.safeEventWatermark.before",
        "durability.pruneEventsSafe.before",
        "durability.forgetEventConsumer.before",
    ]) {
        assert.ok(chaos.history().some((entry) => entry.point === point), `expected a chaos hit at ${point}`);
    }
    // A provider without the optional surface must not appear to support it, so
    // the runtime still fails closed with FENCED_AGENT_WRITE_UNSUPPORTED.
    const bare = {
        async createAgent() { return true; },
        async putAgent() { },
        async getAgent() { return undefined; },
        async listAgents() { return []; },
        async putTask() { },
        async getTask() { return undefined; },
        async putRelation() { },
        async listRelations() { return []; },
        async appendEvent() { },
        async listEvents() { return []; },
    };
    const bareWrapped = new ChaosDurabilityProvider(bare, new ChaosController([]));
    assert.equal(bareWrapped.putAgentFenced, undefined);
    assert.equal(bareWrapped.readEvents, undefined);
    assert.equal(bareWrapped.pruneEvents, undefined);
    assert.equal(bareWrapped.ackEvent, undefined);
    assert.equal(bareWrapped.safeEventWatermark, undefined);
    assert.equal(bareWrapped.pruneEventsSafe, undefined);
    await assert.rejects(persistAgentSnapshot(bareWrapped, agent, fence), /FENCED_AGENT_WRITE_UNSUPPORTED/);
});
test("fault after external execution leaves effect outcome uncertain and blocks replay", async () => {
    const state = new LocalRuntimeStateStore();
    let executions = 0;
    const inner = {
        id: "external",
        fidelity: 5,
        canExecute: () => true,
        async execute() { executions++; return { ok: true, output: "crossed-boundary" }; },
    };
    const chaos = new ChaosController([{ point: "executor.execute.after" }]);
    const broker = new ExecutionBroker([new ChaosExecutor(inner, chaos)], state);
    const effect = { id: "deploy-like", kind: "process.exec", command: "external-side-effect" };
    const context = { agentId: "a", workspaceId: "w" };
    await assert.rejects(broker.execute(effect, context), /Injected chaos fault/);
    assert.equal(executions, 1);
    const second = await broker.execute(effect, context);
    assert.equal(executions, 1);
    assert.equal(second.ok, false);
    assert.match(second.error ?? "", /EFFECT_OUTCOME_UNCERTAIN/);
});
