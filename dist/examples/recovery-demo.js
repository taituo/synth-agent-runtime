import { AgentRuntime, LocalMemoryDurability, LocalRuntimeStateStore, MemoryWorkspace, } from "../src/index.js";
const durability = new LocalMemoryDurability();
const state = new LocalRuntimeStateStore();
const definition = { id: "worker", inferenceProfile: { id: "worker/cheap" } };
const engine = { async run() { return "resumed"; } };
const first = new AgentRuntime(durability, undefined, new Map(), state);
const workspace = await first.createWorkspace(new MemoryWorkspace());
workspace.write("work.txt", "durable overlay");
const agent = await first.spawn({ definition, engine, workspace });
await first.checkpointWorkspace(workspace.id, "demo.before-crash");
// Simulate a fresh control-plane process: no live agents or workspaces are carried over.
const second = new AgentRuntime(durability, undefined, new Map(), state);
const recovered = await second.recover({ definition: () => definition, engine: () => engine });
console.log(recovered);
console.log(second.get(agent.id));
console.log(await second.workspaces.get(workspace.id)?.readText("work.txt"));
