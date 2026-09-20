import {
  AgentRuntime,
  InMemoryWorldStore,
  LocalMemoryDurability,
  MemoryWorkspace,
  Supervisor,
  type AgentEngine,
} from "../src/index.js";

const durability = new LocalMemoryDurability();
const runtime = new AgentRuntime(durability);
const world = new InMemoryWorldStore();
const project = await world.createProject({
  name: "demo",
  objective: "Fan out two coding tasks over isolated workspace forks.",
  constraints: ["Keep changes isolated until review."],
});
const workspace = await runtime.createWorkspace(new MemoryWorkspace());
workspace.write("README.md", "base\n");

const supervisorEngine: AgentEngine = { async run() { return { ok: true }; } };
const supervisor = await runtime.spawn({
  definition: { id: "super", inferenceProfile: { id: "super/strong" } },
  engine: supervisorEngine,
  workspace,
});

const orchestration = new Supervisor(runtime, world);
const children = await orchestration.fanOut({
  supervisorId: supervisor.id,
  projectId: project.id,
  autoRun: false,
  tasks: [
    { title: "A", objective: "Implement A" },
    { title: "B", objective: "Implement B" },
  ],
  engineFactory: (task) => ({ async run() { return { task: task.title, ok: true }; } }),
});

console.log({ project: project.id, supervisor: supervisor.id, children });
console.log((await world.projection(project.id))?.contextText);
