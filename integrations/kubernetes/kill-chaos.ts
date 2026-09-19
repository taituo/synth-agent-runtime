import { spawn } from "node:child_process";
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  KubectlSandboxBackend,
  type KubernetesResourceClass,
} from "../../src/index.js";

const image = process.env.SYNTH_EXECUTOR_IMAGE;
if (!image) throw new Error("Set SYNTH_EXECUTOR_IMAGE to a shell/git capable image pinned by digest");
const context = process.env.SYNTH_KUBECTL_CONTEXT;
const namespace = process.env.SYNTH_KUBERNETES_NAMESPACE ?? "synth-sandboxes";
const base = DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small");
if (!base) throw new Error("sandbox-small resource class missing");
const resourceClass: KubernetesResourceClass = {
  ...base,
  image,
  runtimeClassName: process.env.SYNTH_RUNTIME_CLASS ?? base.runtimeClassName,
  warmPool: undefined,
};
const backend = new KubectlSandboxBackend({ namespace, context });
const sandbox = await backend.create(resourceClass);
try {
  const running = backend.exec(sandbox, { command: "echo STARTED; sleep 300", timeoutMs: 330_000 });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await kubectl(["delete", "pod", sandbox.podName, "-n", sandbox.namespace, "--force", "--grace-period=0", "--wait=false"]);
  const result = await running;
  if (result.exitCode === 0) throw new Error("kubectl exec unexpectedly survived forced Pod deletion");
  console.log(JSON.stringify({ ok: true, sandboxId: sandbox.id, podName: sandbox.podName, exitCode: result.exitCode }));
} finally {
  await backend.destroy(sandbox).catch(() => {});
}

function kubectl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = context ? ["--context", context] : [];
    const child = spawn("kubectl", [...base, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const err: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString("utf8") || `kubectl exited ${code}`)));
  });
}
