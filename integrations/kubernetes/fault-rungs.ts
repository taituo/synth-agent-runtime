/**
 * Track 4 real-rung fault proof.
 *
 * Runs the REAL (gVisor) rung through `KubernetesExecutor` and records what it
 * does for the executor faults in `test/fixtures/fault-matrix.ts`: a successful
 * exec (which also proves workspace materialize/syncBack), a timeout, and a
 * force-delete (SIGKILL) mid-exec that must never report success.
 *
 * Skips cleanly (exit 0, `skipped:true`) when the K8s sandbox is not configured,
 * so it never passes vacuously and never fails for a missing environment.
 *
 *   SYNTH_EXECUTOR_IMAGE=docker.io/library/busybox@sha256:... \
 *   SYNTH_RUNTIME_CLASS=gvisor SYNTH_KUBERNETES_NAMESPACE=synth-audit-gvisor \
 *   integrations/temporal/node_modules/.bin/tsx integrations/kubernetes/fault-rungs.ts
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
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "SYNTH_EXECUTOR_IMAGE not set" }));
  process.exit(0);
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
const executor = new KubernetesExecutor({
  resourceClass,
  backend,
  workspaces: new Map([[workspace.id, workspace]]),
});

function ctx(agentId: string) {
  return { agentId: agentId as never, workspaceId: workspace.id };
}

const results: Record<string, unknown> = {};
let ok = true;

// 1. Successful exec: proves materialize (workspace -> sandbox) and syncBack.
{
  const result = await executor.execute({ id: "r-success", kind: "process.exec", command: "cat /workspace/seed.txt" }, ctx("agt_rung_success"));
  const stdout = (result.output as { stdout?: string } | undefined)?.stdout ?? "";
  const successOk = result.ok && stdout.includes("hello-from-memory");
  results.execSuccess = { ok: result.ok, executor: result.executor, fidelity: result.fidelity, stdout: stdout.trim(), expected: successOk };
  if (!successOk) ok = false;
}

// 2. Write-back: a sandbox write is synced into the memory workspace.
{
  const result = await executor.execute(
    { id: "r-writeback", kind: "process.exec", command: "sh -lc 'echo generated-in-sandbox > /workspace/out.txt'" },
    ctx("agt_rung_writeback"),
  );
  const text = await workspace.readText("out.txt");
  const writeOk = result.ok && text?.trim() === "generated-in-sandbox";
  results.execWriteBack = { ok: result.ok, workspaceText: text?.trim() ?? null, expected: writeOk };
  if (!writeOk) ok = false;
}

// 3. Timeout: a command that outlives its timeout must not report success.
{
  const result = await executor.execute(
    { id: "r-timeout", kind: "process.exec", command: "sleep 10", timeoutMs: 1_000 },
    ctx("agt_rung_timeout"),
  );
  const timeoutOk = !result.ok && result.error === "EXECUTION_TIMEOUT";
  results.execTimeout = { ok: result.ok, error: result.error, expected: timeoutOk };
  if (!timeoutOk) ok = false;
}

// 4. SIGKILL: force-delete the sandbox mid-exec; must never report success.
{
  const agentId = "agt_rung_sigkill";
  const running = executor.execute(
    { id: "r-sigkill", kind: "process.exec", command: "echo STARTED; sleep 300", timeoutMs: 330_000 },
    ctx(agentId),
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await kubectl(["delete", "pods", "-n", namespace, "-l", `synth.openai.dev/agent-id=${agentId}`, "--force", "--grace-period=0", "--wait=false"]);
  const result = await running;
  const sigkillOk = !result.ok;
  results.execSigkill = { ok: result.ok, error: result.error, expected: sigkillOk };
  if (!sigkillOk) ok = false;
}

console.log(JSON.stringify({ ok, namespace, runtimeClass: resourceClass.runtimeClassName, results }, null, 2));
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
