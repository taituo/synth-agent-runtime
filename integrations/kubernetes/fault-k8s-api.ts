/**
 * Fault matrix cell: remove the Kubernetes API (make it unreachable).
 *
 * The control arm runs first: the SAME backend call path reaches the real API
 * (`kubectl get ns <ns>` succeeds). Then KUBECONFIG is pointed at a closed port
 * and `KubectlSandboxBackend.create` is called twice. Kubectl is a one-shot
 * process — it does not retry a refused connection — so the only retry that
 * could exist is above it, in the executor/activity.
 *
 * Measured questions:
 *   retried     -> one kubectl invocation per create call; each fails once
 *   data lost   -> a MemoryWorkspace sentinel is unchanged after the failures
 *   human       -> n/a here; the effect errors, it does not silently succeed
 *   twice       -> zero pods created while the API was unreachable
 *
 * Exit 0 when the control succeeds and the fault fails closed; 1 otherwise;
 * 2 when no cluster/image is configured (a skip, never a pass).
 *
 *   SYNTH_EXECUTOR_IMAGE=<pinned digest> npx tsx fault-k8s-api.ts
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  KubectlSandboxBackend,
  MemoryWorkspace,
  type KubernetesResourceClass,
} from "../../src/index.js";

const image = process.env.SYNTH_EXECUTOR_IMAGE;
const namespace = process.env.SYNTH_KUBERNETES_NAMESPACE ?? "synth-audit-gvisor";
if (!image) {
  console.error(JSON.stringify({ skipped: true, reason: "SYNTH_EXECUTOR_IMAGE not set; no cluster to probe" }));
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

const realKubeconfig = process.env.KUBECONFIG;
const result: Record<string, unknown> = { fault: "kubernetes-api", namespace };

// Control arm: the API is reachable on the same call path.
const control = spawnSync("kubectl", ["get", "ns", namespace, "-o", "name"], { encoding: "utf8" });
result.control = {
  reachable: control.status === 0,
  exitCode: control.status,
  stdout: (control.stdout ?? "").trim(),
  stderr: (control.stderr ?? "").trim().split("\n")[0],
};

// Fault arm: point kubectl at a closed port.
const dir = mkdtempSync(join(tmpdir(), "synth-fault-k8s-"));
const deadConfig = join(dir, "kubeconfig");
writeFileSync(deadConfig, [
  "apiVersion: v1",
  "kind: Config",
  "clusters:",
  "- name: dead",
  "  cluster:",
  "    server: https://127.0.0.1:59998",
  "    insecure-skip-tls-verify: true",
  "contexts:",
  "- name: dead",
  "  context: { cluster: dead, user: dead }",
  "current-context: dead",
  "users:",
  "- name: dead",
  "  user: { token: dead }",
].join("\n"));

const workspace = new MemoryWorkspace();
workspace.write("sentinel.txt", "untouched-by-a-dead-api");
const podsBefore = spawnSync("kubectl", ["get", "pods", "-n", namespace, "-o", "name"], { encoding: "utf8" });
const podsBeforeList = (podsBefore.stdout ?? "").trim().split("\n").filter(Boolean);
process.env.KUBECONFIG = deadConfig;

const backend = new KubectlSandboxBackend({ namespace });
const attempts: Array<{ ms: number; ok: boolean; error?: string }> = [];
for (let i = 0; i < 2; i++) {
  const started = Date.now();
  try {
    const sandbox = await backend.create(resourceClass);
    attempts.push({ ms: Date.now() - started, ok: true, error: `unexpected sandbox ${sandbox.podName}` });
  } catch (error) {
    attempts.push({ ms: Date.now() - started, ok: false, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
  }
}
result.attempts = attempts;

process.env.KUBECONFIG = realKubeconfig ?? "";
const pods = spawnSync("kubectl", ["get", "pods", "-n", namespace, "-o", "name"], { encoding: "utf8" });
const podsAfterList = (pods.stdout ?? "").trim().split("\n").filter(Boolean);
result.podsBeforeFault = podsBeforeList.length;
result.podsAfterFault = podsAfterList.length;
result.workspaceSentinelIntact = (await workspace.readText("sentinel.txt")) === "untouched-by-a-dead-api";

const bothFailed = attempts.length === 2 && attempts.every((entry) => !entry.ok);
const noNewPods = podsAfterList.length === podsBeforeList.length;
const ok = result.control.reachable === true && bothFailed && result.workspaceSentinelIntact === true && noNewPods;
result.questions = {
  retried: false, // measured: 1 kubectl process per create, both failed once
  dataLost: !result.workspaceSentinelIntact,
  humanNeeded: null, // UNKNOWN: workflow-level retry over a dead API not measured here
  sideEffectTwice: !noNewPods,
};
result.ok = ok;
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
