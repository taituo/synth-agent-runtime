/**
 * Fault matrix cell: remove the sandbox pod (kill it mid-exec).
 *
 * The control arm execs a trivial command and reads the materialized file, so
 * the exec path is known to work before the pod is killed. The fault arm runs a
 * command that WRITES a file and then sleeps; the pod is force-deleted at ~2s.
 * The discriminating question is the in-flight write: `syncBack` only runs on a
 * successful exec, so a write made before the kill must not silently appear in
 * the host workspace.
 *
 * Measured questions:
 *   retried     -> the executor surfaces the kill as one failed exec (no retry)
 *   data lost   -> the write made before the kill is absent from the workspace
 *   human       -> UNKNOWN here (workflow-level reconciliation not measured)
 *   twice       -> not applicable while the pod is gone; the durable-layer
 *                  dedup is proven separately by effect-receipt-live.ts
 *
 * Exit 0 when the control passes and the kill fails closed with the write lost;
 * 1 otherwise; 2 when the sandbox is not configured.
 *
 *   SYNTH_EXECUTOR_IMAGE=<pinned digest> SYNTH_KUBERNETES_NAMESPACE=synth-audit-gvisor \
 *     npx tsx fault-sandbox-pod.ts
 */
import { spawn } from "node:child_process";
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  KubectlSandboxBackend,
  KubernetesExecutor,
  MemoryWorkspace,
  type KubernetesResourceClass,
} from "../../src/index.js";

const image = process.env.SYNTH_EXECUTOR_IMAGE;
const namespace = process.env.SYNTH_KUBERNETES_NAMESPACE ?? "synth-audit-gvisor";
const context = process.env.SYNTH_KUBECTL_CONTEXT;
if (!image) {
  console.error(JSON.stringify({ skipped: true, reason: "SYNTH_EXECUTOR_IMAGE not set; no sandbox to probe" }));
  process.exit(2);
}

const base = DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small");
if (!base) throw new Error("sandbox-small resource class missing");
const resourceClass: KubernetesResourceClass = {
  ...base,
  image,
  runtimeClassName: process.env.SYNTH_RUNTIME_CLASS ?? base.runtimeClassName,
  warmPool: undefined,
};

const backend = new KubectlSandboxBackend({ namespace, context });
const workspace = new MemoryWorkspace();
workspace.write("seed.txt", "hello-from-memory");
const executor = new KubernetesExecutor({ resourceClass, backend, workspaces: new Map([[workspace.id, workspace]]) });

const result: Record<string, unknown> = { fault: "sandbox-pod", namespace };

// Control: the exec path works and materializes the workspace.
const control = await executor.execute(
  { id: "sp-control", kind: "process.exec", command: "cat /workspace/seed.txt" },
  { agentId: "agt_fault_pod_control" as never, workspaceId: workspace.id },
);
const controlStdout = ((control.output as { stdout?: string })?.stdout ?? "").trim();
result.control = { ok: control.ok, stdout: controlStdout };

// Fault: write inside the pod, then be killed before the write can sync back.
const agentId = "agt_fault_pod_killed";
const started = executor.execute(
  {
    id: "sp-killed",
    kind: "process.exec",
    command: "sh -lc 'echo partial > /workspace/inflight.txt; echo RAN; sleep 300'",
    timeoutMs: 330_000,
  },
  { agentId: agentId as never, workspaceId: workspace.id },
);
await new Promise((resolve) => setTimeout(resolve, 2_000));
await kubectl(["delete", "pods", "-n", namespace, "-l", `synth.openai.dev/agent-id=${agentId}`, "--force", "--grace-period=0", "--wait=false"]);
const killed = await started;
result.killed = { ok: killed.ok, error: killed.error };
result.inflightWriteSyncedBack = (await workspace.readText("inflight.txt")) !== undefined;

const controlOk = control.ok && controlStdout.includes("hello-from-memory");
const killedFailedClosed = !killed.ok;
const dataLost = !result.inflightWriteSyncedBack;
const ok = controlOk && killedFailedClosed && dataLost;
result.questions = {
  retried: false, // one executor call; the kill is surfaced as a failure
  dataLost,
  humanNeeded: null, // UNKNOWN: workflow-level reconciliation not measured here
  sideEffectTwice: null, // covered by effect-receipt-live.ts at the durable layer
};
result.ok = ok;
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);

function kubectl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const baseArgs = context ? ["--context", context] : [];
    const child = spawn("kubectl", [...baseArgs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const err: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString("utf8") || `kubectl exited ${code}`))));
  });
}
