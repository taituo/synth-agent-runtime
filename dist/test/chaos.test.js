import test from "node:test";
import assert from "node:assert/strict";
import { ChaosController, ChaosExecutor, ExecutionBroker, LocalRuntimeStateStore, runCrashRecoveryScenario, } from "../src/index.js";
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
