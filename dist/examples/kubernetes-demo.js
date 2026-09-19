import { AgentRuntime, DEFAULT_KUBERNETES_RESOURCE_CLASSES, ExecutionBroker, KubernetesExecutor, KubectlSandboxBackend, LocalMemoryDurability, MemoryWorkspace, SyntheticExecutor, WarmSandboxPool, } from "../src/index.js";
const image = process.env.SYNTH_EXECUTOR_IMAGE ?? "ghcr.io/example/synth-executor:latest";
const classes = DEFAULT_KUBERNETES_RESOURCE_CLASSES
    .filter((entry) => entry.id !== "project-cell")
    .map((entry) => ({ ...entry, image }));
const workspaces = new Map();
const backend = new KubectlSandboxBackend({ namespace: process.env.SYNTH_K8S_NAMESPACE ?? "synth-sandboxes" });
const pool = new WarmSandboxPool(backend, classes);
await pool.maintain();
const executors = [
    new SyntheticExecutor(workspaces),
    ...classes.map((resourceClass) => new KubernetesExecutor({ resourceClass, backend, workspaces, pool })),
];
const broker = new ExecutionBroker(executors);
const runtime = new AgentRuntime(new LocalMemoryDurability(), broker, workspaces);
const workspace = await runtime.createWorkspace(new MemoryWorkspace());
workspace.write("package.json", JSON.stringify({ scripts: { test: "node -e \"console.log('physical sandbox ok')\"" } }, null, 2));
const engine = {
    async run(_messages, context) {
        const result = await context.executeEffect?.({
            id: "validate",
            kind: "process.exec",
            command: "npm test",
            resourceClass: "sandbox-small",
            timeoutMs: 120_000,
        });
        if (!result?.ok)
            throw new Error(result?.error ?? "physical execution failed");
        return result.output;
    },
};
const agent = await runtime.spawn({
    definition: {
        id: "k8s-demo",
        inferenceProfile: { id: "demo" },
        executionPolicy: {
            preferredClass: "sandbox-small",
            allowedClasses: ["sandbox-small", "sandbox-medium", "sandbox-heavy"],
            allowEscalation: true,
        },
    },
    engine,
    workspace,
});
try {
    console.log(await runtime.run(agent.id));
}
finally {
    await pool.close();
}
