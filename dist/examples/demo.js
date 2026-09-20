import { ExecutionBroker, MemoryWorkspace, SyntheticExecutor, createGatewayAgentEngine, } from "../src/index.js";
/**
 * One turn through the shared turn body (`GatewayAgentEngine`): the model call
 * and the tool call it asks for, with the tool dispatched through the execution
 * rung. The gateway response is injected so the demo runs without a live model;
 * in production the same engine is the `runTurn` activity inside the Temporal
 * workflow.
 */
const workspace = new MemoryWorkspace();
const workspaces = new Map([[workspace.id, workspace]]);
const broker = new ExecutionBroker([new SyntheticExecutor(workspaces)]);
const engine = createGatewayAgentEngine({
    baseUrl: "http://demo-gateway.invalid",
    model: "demo/model",
    systemPrompt: "You edit files. Reply with tool_calls.",
    buildUserMessage: (messages) => messages.map((message) => message.text).join("\n"),
    fetchImpl: (async () => new Response(JSON.stringify({
        model: "demo/model",
        choices: [{ message: { role: "assistant", content: JSON.stringify({ tool_calls: [
                            { name: "write_file", arguments: { path: "src/hello.ts", content: "export const hello = 'synthetic';\n" } },
                        ] }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } })),
    toEffect: (call) => (call.name === "write_file"
        ? { id: "demo-write", kind: "workspace.write", path: String(call.arguments.path ?? ""), content: String(call.arguments.content ?? "") }
        : undefined),
});
const agentId = "agt_demo";
const context = {
    agentId,
    workspaceId: workspace.id,
    definition: { id: "demo", inferenceProfile: { id: "demo/model" } },
    inferenceProfile: { id: "demo/model" },
    signal: new AbortController().signal,
    emitTool: (name, phase, data) => console.log("tool", name, phase, data ?? ""),
    emitOutput: (text) => console.log("output", text),
    executeEffect: (effect, minFidelity) => broker.execute(effect, { agentId, workspaceId: workspace.id }, minFidelity),
};
const outcome = await engine.run([{ id: "m1", role: "human", text: "Create src/hello.ts", createdAt: Date.now() }], context);
console.log("observations", outcome.observations);
console.log("workspace file", await workspace.readText("src/hello.ts"));
