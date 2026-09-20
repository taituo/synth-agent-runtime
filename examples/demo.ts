import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, FileSystemBlobStore, LocalMemoryDurability, MemoryWorkspace, type AgentEngine } from "../src/index.js";

const durability = new LocalMemoryDurability();
const runtime = new AgentRuntime(durability);
const workspace = await runtime.createWorkspace(new MemoryWorkspace());
const task = await runtime.createTask({ title: "demo", objective: "Edit src/hello.ts in memory" });
// Artifacts carry a reference; the bytes live in the blob store.
const artifacts = new FileSystemBlobStore(await mkdtemp(join(tmpdir(), "synth-demo-artifacts-")));

const engine: AgentEngine = {
  async run(_messages, ctx) {
    const ws = runtime.workspaces.get(ctx.workspaceId)!;
    ctx.emitTool("write", "start", { path: "src/hello.ts" });
    ws.write("src/hello.ts", "export const hello = 'synthetic';\n");
    ctx.emitTool("write", "end");
    ctx.emitOutput("Edited entirely in memory.");
    return ws.exportArtifact(artifacts);
  },
};

const agent = await runtime.spawn({
  definition: { id: "worker", inferenceProfile: { id: "worker/cheap" } },
  engine,
  workspace,
  task,
});

const detach = runtime.attach((event) => console.log(event.type, JSON.stringify(event)));
await runtime.send(agent.id, "Do the task");
const result = await runtime.run(agent.id);
detach();
console.log("RESULT", result);
