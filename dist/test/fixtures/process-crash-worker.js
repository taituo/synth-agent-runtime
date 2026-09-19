import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { DurableTurn } from "../../src/runtime/durable-turn.js";
import { JsonFileDurabilityProvider } from "../../src/durability/json-file-durability.js";
import { JsonFileRuntimeStateStore } from "../../src/durability/json-file-runtime-state.js";
import { MemoryWorkspace } from "../../src/workspace/memory-workspace.js";
const [durabilityPath, statePath] = process.argv.slice(2);
if (!durabilityPath || !statePath)
    throw new Error("usage: process-crash-worker <durability.json> <runtime-state.json>");
const durability = new JsonFileDurabilityProvider(durabilityPath);
const state = new JsonFileRuntimeStateStore(statePath);
const runtime = new AgentRuntime(durability, undefined, new Map(), state);
const workspace = await runtime.createWorkspace(new MemoryWorkspace());
const definition = {
    id: "crash-worker",
    inferenceProfile: { id: "test" },
};
let ready = false;
const snapshot = await runtime.spawn({
    definition,
    workspace,
    engine: {
        async run(_messages, context) {
            const turn = await DurableTurn.begin({
                workspace,
                agentId: context.agentId,
                attemptId: "attempt-before-crash",
                store: state,
            });
            workspace.write("dirty-before-crash.txt", "must disappear after recovery");
            ready = true;
            process.stdout.write(`${JSON.stringify({ type: "ready", agentId: snapshot.id, workspaceId: workspace.id, turnId: turn.id })}\n`);
            await new Promise(() => { });
        },
    },
});
void runtime.run(snapshot.id);
setTimeout(() => {
    if (!ready) {
        process.stderr.write("worker failed to enter durable turn\n");
        process.exit(2);
    }
}, 5_000).unref();
