import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  EXECUTOR_IMAGE,
  ExecutionBroker,
  KubernetesExecutor,
  KubectlSandboxBackend,
  MemoryWorkspace,
  SyntheticExecutor,
  WarmSandboxPool,
  type AgentId,
  type KubernetesResourceClass,
} from "../src/index.js";

/**
 * Drives one effect through the execution rung: the cheap synthetic executor
 * cannot run `process.exec`, so the broker escalates to the Kubernetes/gVisor
 * executor. There is no homegrown runtime in this path — the execution rung is
 * the only place model-authored code runs.
 */
const image = process.env.SYNTH_EXECUTOR_IMAGE ?? EXECUTOR_IMAGE;
const classes: KubernetesResourceClass[] = DEFAULT_KUBERNETES_RESOURCE_CLASSES
  .filter((entry) => entry.id !== "project-cell")
  .map((entry) => ({ ...entry, image }));

const workspaces = new Map();
const workspace = new MemoryWorkspace();
workspaces.set(workspace.id, workspace);
workspace.write(
  "package.json",
  JSON.stringify({ scripts: { test: "node -e \"console.log('physical sandbox ok')\"" } }, null, 2),
);

const backend = new KubectlSandboxBackend({ namespace: process.env.SYNTH_K8S_NAMESPACE ?? "synth-sandboxes" });
const pool = new WarmSandboxPool(backend, classes);
await pool.maintain();

const executors = [
  new SyntheticExecutor(workspaces),
  ...classes.map((resourceClass) => new KubernetesExecutor({ resourceClass, backend, workspaces, pool })),
];
const broker = new ExecutionBroker(executors);

try {
  const result = await broker.execute(
    { id: "validate", kind: "process.exec", command: "npm test", resourceClass: "sandbox-small", timeoutMs: 120_000 },
    {
      agentId: "k8s-demo" as AgentId,
      workspaceId: workspace.id,
      executionPolicy: {
        preferredClass: "sandbox-small",
        allowedClasses: ["sandbox-small", "sandbox-medium", "sandbox-heavy"],
        allowEscalation: true,
      },
    },
  );
  if (!result.ok) throw new Error(result.error ?? "physical execution failed");
  console.log(result.output);
} finally {
  await pool.close();
}
