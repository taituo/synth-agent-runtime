import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayAgentEngine } from "../src/runtime/gateway-engine.js";
import { ExecutionBroker } from "../src/execution/broker.js";
import { SyntheticExecutor } from "../src/execution/synthetic.js";
import { MemoryWorkspace } from "../src/workspace/memory-workspace.js";
/** A counting wrapper that delegates to the real synthetic rung. */
class CountingExecutor {
    id = "counting-synthetic";
    fidelity = 0;
    count = 0;
    #inner;
    constructor(workspaces) {
        this.#inner = new SyntheticExecutor(workspaces);
    }
    canExecute(effect, _context) {
        return this.#inner.canExecute(effect);
    }
    async execute(effect, context) {
        this.count++;
        return this.#inner.execute(effect, context);
    }
}
test("the gateway engine executes the model's tool calls through the execution rung", async () => {
    const workspace = new MemoryWorkspace();
    workspace.write("a.txt", "hello from the rung");
    const workspaces = new Map([[workspace.id, workspace]]);
    const executor = new CountingExecutor(workspaces);
    const broker = new ExecutionBroker([executor]);
    const engine = createGatewayAgentEngine({
        baseUrl: "http://gw.test",
        model: "m",
        systemPrompt: "system",
        buildUserMessage: (messages) => messages.map((message) => message.text).join("\n"),
        fetchImpl: (async () => new Response(JSON.stringify({
            model: "m",
            choices: [{ message: { role: "assistant", content: JSON.stringify({ tool_calls: [{ name: "read_file", arguments: { path: "a.txt" } }] }) } }],
        }), { status: 200, headers: { "content-type": "application/json" } })),
        toEffect: (call) => (call.name === "read_file" ? { id: "fx_read", kind: "workspace.read", path: String(call.arguments.path ?? "") } : undefined),
    });
    const agentId = "agt_engine";
    const context = {
        agentId,
        workspaceId: workspace.id,
        definition: { id: "def", inferenceProfile: { id: "m" } },
        inferenceProfile: { id: "m", model: "m" },
        signal: new AbortController().signal,
        emitOutput: () => { },
        emitTool: () => { },
        executeEffect: (effect, minFidelity) => broker.execute(effect, { agentId, workspaceId: workspace.id }, minFidelity),
    };
    const outcome = await engine.run([{ id: "m1", role: "human", text: "read a.txt", createdAt: 1 }], context);
    assert.equal(executor.count, 1, "the engine must dispatch exactly one effect through the rung");
    const observation = outcome.observations[0];
    assert.equal(observation.name, "read_file");
    assert.equal(observation.ok, true);
    assert.equal(new TextDecoder().decode(observation.output), "hello from the rung");
});
