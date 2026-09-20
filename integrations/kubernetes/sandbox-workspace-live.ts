/**
 * Live proof: the sandbox rung's workspace medium is the Pod, not worker RAM.
 *
 * Runs the REAL gVisor rung through `SandboxWorkspaceExecutor` and shows that
 * `workspace.write/read/list` and `process.exec` all execute inside the Pod:
 * the host cache workspace is untouched until `checkpoint()`, and a host
 * sentinel file is never touched.
 *
 * Exit codes: 0 = every expectation held; 1 = failed; 2 = SKIPPED (no
 * SYNTH_EXECUTOR_IMAGE). A skip is a distinct outcome, never `ok:true`.
 *
 *   SYNTH_EXECUTOR_IMAGE=<git-capable image pinned by digest> \
 *   SYNTH_KUBERNETES_NAMESPACE=synth-audit-gvisor SYNTH_RUNTIME_CLASS=gvisor \
 *   npx tsx integrations/kubernetes/sandbox-workspace-live.ts
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  FileSystemBlobStore,
  KubectlSandboxBackend,
  MemoryWorkspace,
  SandboxWorkspaceExecutor,
  checkpointSandboxWorkspace,
  type AgentId,
  type EffectContext,
  type KubernetesResourceClass,
  type WorkspaceId,
} from "../../src/index.js";

const image = process.env.SYNTH_EXECUTOR_IMAGE;
const namespace = process.env.SYNTH_KUBERNETES_NAMESPACE ?? "synth-audit-gvisor";
if (!image) {
  console.error(JSON.stringify({ skipped: true, reason: "SYNTH_EXECUTOR_IMAGE not set; must be a git-capable image pinned by digest" }));
  process.exit(2);
}

const base = DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small")!;
const resourceClass: KubernetesResourceClass = {
  ...base,
  image,
  runtimeClassName: process.env.SYNTH_RUNTIME_CLASS ?? base.runtimeClassName,
  warmPool: undefined,
};

const backend = new KubectlSandboxBackend({
  namespace,
  ...(process.env.SYNTH_KUBECTL_CONTEXT ? { context: process.env.SYNTH_KUBECTL_CONTEXT } : {}),
});
const workspaceId = `ws_live_${Date.now()}` as WorkspaceId;
const cache = new MemoryWorkspace({ id: workspaceId });
const executor = new SandboxWorkspaceExecutor({ resourceClass, backend, workspaces: new Map([[workspaceId, cache]]) });
const context: EffectContext = {
  agentId: "agt_live" as AgentId,
  workspaceId,
  executionPolicy: { preferredClass: resourceClass.id, allowedClasses: [resourceClass.id], allowEscalation: true },
};

const hostDir = await mkdtemp(join(tmpdir(), "synth-live-host-"));
const hostSentinel = join(hostDir, "sentinel.txt");
await writeFile(hostSentinel, "host-untouched");
const blobDir = await mkdtemp(join(tmpdir(), "synth-live-blobs-"));
let result: Record<string, unknown> = {};
try {
  const write = await executor.execute({ id: "w1", kind: "workspace.write", path: "live/a.txt", content: "pod-bytes" }, context);
  const read = await executor.execute({ id: "r1", kind: "workspace.read", path: "live/a.txt" }, context);
  const list = await executor.execute({ id: "l1", kind: "workspace.list", path: "live" }, context);
  const exec = await executor.execute({ id: "e1", kind: "process.exec", command: "cat live/a.txt", resourceClass: resourceClass.id }, context);
  const readBack = read.ok ? new TextDecoder().decode(read.output as Uint8Array) : undefined;
  const execOutput = exec.ok ? (exec.output as { stdout?: string }).stdout?.trim() : undefined;
  const cacheBeforeCheckpoint = await cache.readText("live/a.txt");
  const ref = await checkpointSandboxWorkspace(executor, workspaceId, new FileSystemBlobStore(blobDir));
  const cacheAfterCheckpoint = await cache.readText("live/a.txt");
  const sentinel = await readFile(hostSentinel, "utf8");

  const ok =
    write.ok && read.ok && list.ok && exec.ok
    && readBack === "pod-bytes"
    && execOutput === "pod-bytes"
    && JSON.stringify(list.output) === JSON.stringify(["a.txt"])
    && cacheBeforeCheckpoint === undefined
    && cacheAfterCheckpoint === "pod-bytes"
    && sentinel === "host-untouched"
    && ref !== undefined;
  result = {
    executor: executor.id,
    writeOk: write.ok,
    readBack,
    list: list.output,
    execOutput,
    cacheBeforeCheckpoint,
    cacheAfterCheckpoint,
    hostSentinel: sentinel,
    checkpointDigest: ref?.digest,
    checkpointSize: ref?.size,
    ok,
  };
} catch (error) {
  result = { ok: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  await executor.close().catch(() => {});
  await rm(hostDir, { recursive: true, force: true });
  await rm(blobDir, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok === true ? 0 : 1);
