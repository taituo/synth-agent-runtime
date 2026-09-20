import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  ExecutionBroker,
  KubectlSandboxBackend,
  KubernetesExecutor,
  MemoryWorkspace,
  ProjectCellManager,
  WarmSandboxPool,
  WorkspaceSynchronizer,
  assertValidNamespace,
  buildProjectServicePod,
  buildSandboxNetworkPolicy,
  buildSandboxPod,
  deletePodAndPolicyArgs,
  type Effect,
  type EffectContext,
  type Executor,
  type KubernetesObject,
  type KubernetesObjectController,
  type KubernetesResourceClass,
  type SandboxBackend,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxIdentity,
  type SourceInfo,
  type TreeSource,
} from "../src/index.js";

class MockSandboxBackend implements SandboxBackend {
  creates = 0;
  resets = 0;
  destroys = 0;
  files = new Map<string, Uint8Array>();
  baseline = new Map<string, Uint8Array>();
  links = new Map<string, string>();
  baselineLinks = new Map<string, string>();

  async create(resourceClass: KubernetesResourceClass, options: { namespace?: string } = {}): Promise<SandboxIdentity> {
    this.creates++;
    return {
      id: `sandbox-${this.creates}`,
      namespace: options.namespace ?? "test",
      podName: `pod-${this.creates}`,
      resourceClassId: resourceClass.id,
      createdAt: Date.now(),
    };
  }
  async destroy(): Promise<void> { this.destroys++; }
  async reset(): Promise<void> { this.resets++; this.files.clear(); this.baseline.clear(); this.links.clear(); this.baselineLinks.clear(); }
  async exec(_sandbox: SandboxIdentity, request: SandboxExecRequest): Promise<SandboxExecResult> {
    if (request.command.includes("git init")) {
      this.baseline = cloneMap(this.files);
      this.baselineLinks = new Map(this.links);
    }
    if (request.command === "mutate") {
      this.files.set("a.txt", new TextEncoder().encode("physical"));
      this.links.set("link.txt", "a.txt");
    }
    return { exitCode: 0, stdout: "ok", stderr: "" };
  }
  async writeFile(_sandbox: SandboxIdentity, path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content.slice());
    this.links.delete(path);
  }
  async readFile(_sandbox: SandboxIdentity, path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (!value) throw new Error(`missing ${path}`);
    return value.slice();
  }
  async writeSymlink(_sandbox: SandboxIdentity, path: string, target: string): Promise<void> {
    this.links.set(path, target);
    this.files.delete(path);
  }
  async readSymlink(_sandbox: SandboxIdentity, path: string): Promise<string> {
    const target = this.links.get(path);
    if (target === undefined) throw new Error(`missing symlink ${path}`);
    return target;
  }
  async removePath(_sandbox: SandboxIdentity, path: string): Promise<void> { this.files.delete(path); this.links.delete(path); }
  async listGitChanges(): Promise<Array<{ path: string; deleted: boolean; symlink?: boolean }>> {
    const paths = new Set([...this.files.keys(), ...this.baseline.keys(), ...this.links.keys(), ...this.baselineLinks.keys()]);
    const changes: Array<{ path: string; deleted: boolean; symlink?: boolean }> = [];
    for (const path of [...paths].sort()) {
      const baselineLink = this.baselineLinks.get(path);
      const currentLink = this.links.get(path);
      const baselineFile = this.baseline.get(path);
      const currentFile = this.files.get(path);
      const sameEntry =
        baselineLink !== undefined || currentLink !== undefined
          ? baselineLink === currentLink
          : same(baselineFile, currentFile);
      if (sameEntry) continue;
      changes.push({ path, deleted: currentLink === undefined && currentFile === undefined, ...(currentLink !== undefined ? { symlink: true } : {}) });
    }
    return changes;
  }
}

function cloneMap(input: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...input].map(([k, v]) => [k, v.slice()]));
}
function same(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

class TinySource implements TreeSource {
  readonly name = "tiny";
  readonly files = new Map([["a.txt", new TextEncoder().encode("base")]]);
  async revision() { return { kind: "snapshot" as const }; }
  async stat(path: string): Promise<SourceInfo | undefined> {
    if (path === "") return { path, kind: "directory", size: 0, mtimeMs: 0 };
    const value = this.files.get(path);
    return value ? { path, kind: "file", size: value.length, mtimeMs: 0 } : undefined;
  }
  async listDir() { return [{ path: "a.txt", kind: "file" as const, size: 4, mtimeMs: 0 }]; }
  async readFile(path: string) { return this.files.get(path)!.slice(); }
  async *listFiles() { yield "a.txt"; }
}

test("sandbox manifest uses restricted isolation and gVisor", () => {
  const cls = DEFAULT_KUBERNETES_RESOURCE_CLASSES[0]!;
  const pod = buildSandboxPod("test", "pod", "sandbox", cls) as any;
  assert.equal(pod.spec.runtimeClassName, "gvisor");
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);
  assert.equal(pod.spec.securityContext.seccompProfile.type, "RuntimeDefault");
  const container = pod.spec.containers[0];
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.equal(container.resources.limits.memory, "4Gi");

  const network = buildSandboxNetworkPolicy("test", "network", "sandbox", cls.network) as any;
  assert.deepEqual(network.spec.policyTypes, ["Ingress", "Egress"]);
  assert.ok(network.spec.egress.some((rule: any) => rule.ports?.some((port: any) => port.port === 53)));
  assert.ok(network.spec.egress.some((rule: any) => rule.ports?.some((port: any) => port.port === 3128)));
  assert.equal(JSON.stringify(network).includes("0.0.0.0/0"), false);
});

test("warm pool reuses a reset sandbox", async () => {
  const backend = new MockSandboxBackend();
  const cls = { ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0]!, warmPool: { minReady: 1, maxReady: 1, maxTotal: 2, idleTtlMs: 60_000 } };
  const pool = new WarmSandboxPool(backend, [cls]);
  await pool.maintain();
  assert.equal(backend.creates, 1);
  const first = await pool.acquire(cls.id);
  const firstId = first.sandbox.id;
  await first.release();
  assert.equal(backend.resets, 1);
  const second = await pool.acquire(cls.id);
  assert.equal(second.sandbox.id, firstId);
  await second.release();
  await pool.close();
});

test("physical executor materializes sparse workspace and syncs source changes back", async () => {
  const backend = new MockSandboxBackend();
  const cls = { ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0]!, warmPool: undefined };
  const workspace = new MemoryWorkspace({ source: new TinySource() });
  const workspaces = new Map([[workspace.id, workspace]]);
  const executor = new KubernetesExecutor({ resourceClass: cls, backend, workspaces });
  const effect: Effect = { id: "e1", kind: "process.exec", command: "mutate", resourceClass: cls.id };
  const context: EffectContext = { agentId: "agent-1" as any, workspaceId: workspace.id };
  const result = await executor.execute(effect, context);
  assert.equal(result.ok, true);
  assert.equal(await workspace.readText("a.txt"), "physical");
  assert.equal(backend.destroys, 1);
});

test("broker honors preferred resource class transparently", async () => {
  const called: string[] = [];
  const make = (id: string, fidelity: number): Executor => ({
    id: `x:${id}`,
    resourceClassId: id,
    fidelity,
    canExecute: () => true,
    execute: async () => { called.push(id); return { ok: true, output: id }; },
  });
  const broker = new ExecutionBroker([make("sandbox-small", 20), make("sandbox-medium", 30)]);
  const result = await broker.execute(
    { id: "e", kind: "process.exec", command: "true" },
    {
      agentId: "a" as any,
      workspaceId: "w" as any,
      executionPolicy: { preferredClass: "sandbox-medium", allowedClasses: ["sandbox-small", "sandbox-medium"] },
    },
  );
  assert.equal(result.output, "sandbox-medium");
  assert.deepEqual(called, ["sandbox-medium"]);
});


test("warm pool destroys a sandbox when reset verification fails", async () => {
  class FailingVerifyBackend extends MockSandboxBackend {
    async verifyReset(): Promise<boolean> { return false; }
  }
  const backend = new FailingVerifyBackend();
  const cls = { ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0]!, warmPool: { minReady: 0, maxReady: 1, maxTotal: 1, idleTtlMs: 60_000 } };
  const pool = new WarmSandboxPool(backend, [cls]);
  const lease = await pool.acquire(cls.id);
  await lease.release();
  assert.equal(backend.resets, 1);
  assert.equal(backend.destroys, 1);
  await pool.close();
});

test("warm pool does not double-lease a slot created while another caller is waiting", async () => {
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  class SlowCreateBackend extends MockSandboxBackend {
    override async create(resourceClass: KubernetesResourceClass, options: { namespace?: string } = {}): Promise<SandboxIdentity> {
      await createGate;
      return super.create(resourceClass, options);
    }
  }
  const backend = new SlowCreateBackend();
  const cls = {
    ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0]!,
    warmPool: { minReady: 0, maxReady: 1, maxTotal: 1, idleTtlMs: 60_000 },
  };
  const pool = new WarmSandboxPool(backend, [cls]);

  const firstPromise = pool.acquire(cls.id);
  // Allow acquire() to register its in-flight creation before the second caller.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondPromise = pool.acquire(cls.id);
  releaseCreate();

  const first = await firstPromise;
  let secondResolved = false;
  void secondPromise.then(() => { secondResolved = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(secondResolved, false, "second caller must wait while the only slot is leased");

  const firstId = first.sandbox.id;
  await first.release();
  const second = await secondPromise;
  assert.equal(second.sandbox.id, firstId);
  await second.release();
  await pool.close();
});

test("warm pool rejects queued acquirers on close instead of hanging", async () => {
  const backend = new MockSandboxBackend();
  const cls = {
    ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0]!,
    warmPool: { minReady: 0, maxReady: 1, maxTotal: 1, idleTtlMs: 60_000 },
  };
  const pool = new WarmSandboxPool(backend, [cls]);
  const first = await pool.acquire(cls.id);
  const waiting = pool.acquire(cls.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pool.stats()[cls.id]?.waiting, 1);
  await pool.close();
  await assert.rejects(waiting, /pool is closed/i);
  await first.release();
});


test("workspace sync-back is atomic when sandbox output exceeds limits", async () => {
  class OversizeBackend extends MockSandboxBackend {
    override async listGitChanges(): Promise<Array<{ path: string; deleted: boolean }>> {
      return [
        { path: "first.txt", deleted: false },
        { path: "huge.txt", deleted: false },
      ];
    }
    override async readFile(_sandbox: SandboxIdentity, path: string): Promise<Uint8Array> {
      return new TextEncoder().encode(path === "first.txt" ? "small" : "x".repeat(64));
    }
  }
  const backend = new OversizeBackend();
  const workspace = new MemoryWorkspace();
  workspace.write("existing.txt", "keep");
  const sync = new WorkspaceSynchronizer(backend, { maxBytes: 16, maxFiles: 10 });
  const sandbox: SandboxIdentity = {
    id: "s", namespace: "n", podName: "p", resourceClassId: "sandbox-small", createdAt: 1,
  };
  await assert.rejects(sync.syncBack(workspace, sandbox), /byte limit/);
  assert.equal(await workspace.readText("existing.txt"), "keep");
  assert.equal(await workspace.readText("first.txt"), undefined);
  assert.equal(await workspace.readText("huge.txt"), undefined);
});

test("workspace sync preserves symlinks in both directions", async () => {
  const backend = new MockSandboxBackend();
  const sandbox: SandboxIdentity = { id: "s", namespace: "n", podName: "p", resourceClassId: "sandbox-small", createdAt: 1 };
  const workspace = new MemoryWorkspace();
  workspace.write("a.txt", "base");
  workspace.symlink("link.txt", "a.txt");
  const sync = new WorkspaceSynchronizer(backend);

  await sync.materialize(workspace, sandbox);
  assert.equal(backend.links.get("link.txt"), "a.txt", "materialize must write mode 120000 with the link target");
  assert.equal(backend.files.has("link.txt"), false, "materialize must not flatten the link into regular bytes");

  // A sandbox-created symlink must return as a link, not the bytes it points at.
  await backend.writeSymlink(sandbox, "new-link", "a.txt");
  const back = new MemoryWorkspace();
  await sync.syncBack(back, sandbox);
  assert.equal((await back.stat("new-link"))?.kind, "symlink", "syncBack must preserve mode 120000");
  assert.equal((await back.snapshot()).links?.get("new-link"), "a.txt", "syncBack must carry the link target, not the target's bytes");
});

test("project service pod carries a requested RuntimeClass", () => {
  const pod = buildProjectServicePod("test", "cell-1", {
    name: "db",
    image: "postgres:16-alpine",
    runtimeClassName: "gvisor",
  }) as any;
  assert.equal(pod.spec.runtimeClassName, "gvisor");
  assert.equal(pod.spec.restartPolicy, "Always");
  assert.equal(pod.spec.automountServiceAccountToken, false);
});

test("project service pod omits an empty RuntimeClass instead of emitting an invalid pod", () => {
  for (const runtimeClassName of [undefined, ""]) {
    const pod = buildProjectServicePod("test", "cell-1", {
      name: "db",
      image: "postgres:16-alpine",
      ...(runtimeClassName === undefined ? {} : { runtimeClassName }),
    }) as any;
    assert.ok(
      !("runtimeClassName" in pod.spec) || pod.spec.runtimeClassName === undefined,
      `runtimeClassName must be omitted when ${JSON.stringify(runtimeClassName)}`,
    );
  }
});

class FakeProjectCellController implements KubernetesObjectController {
  applied: string[] = [];
  deleted: string[] = [];
  activeNamespaces = new Set<string>();
  failWait = false;
  delayMs = 0;
  async apply(object: KubernetesObject): Promise<void> {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const name = String((object.metadata as { name: string }).name);
    if (object.kind === "Namespace") this.activeNamespaces.add(name);
    this.applied.push(`${String(object.kind)}/${name}`);
  }
  async waitPodReady(_namespace: string, podName: string): Promise<void> {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failWait) throw new Error(`Pod ${podName} not ready`);
  }
  async deleteNamespace(namespace: string): Promise<void> {
    this.activeNamespaces.delete(namespace);
    this.deleted.push(namespace);
  }
}

function projectCellClass(): KubernetesResourceClass {
  return { ...DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "project-cell")! };
}

test("caller-supplied Kubernetes namespaces are validated, not silently rewritten", async () => {
  assert.equal(assertValidNamespace("synth-sandboxes"), "synth-sandboxes");
  for (const bad of ["", "Bad_Namespace", "UPPER", "-leading", "trailing-", "has space", "a".repeat(64), "dotted.name"]) {
    assert.throws(() => assertValidNamespace(bad), /Invalid Kubernetes namespace/, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.throws(() => new KubectlSandboxBackend({ namespace: "Bad_Namespace" }), /Invalid Kubernetes namespace/);
  const backend = new KubectlSandboxBackend({ namespace: "synth-sandboxes" });
  await assert.rejects(
    backend.create(DEFAULT_KUBERNETES_RESOURCE_CLASSES[0]!, { namespace: "Bad_Namespace" }),
    /Invalid Kubernetes namespace/,
  );
});

test("project cell rejects an invalid caller-supplied namespace before applying anything", async () => {
  const controller = new FakeProjectCellController();
  const backend = new MockSandboxBackend();
  const manager = new ProjectCellManager(controller, backend, [projectCellClass()]);
  await assert.rejects(manager.ensure({ id: "cell-1", namespace: "Bad_Namespace" }), /Invalid Kubernetes namespace/);
  assert.deepEqual(controller.applied, []);
  assert.equal(backend.creates, 0);
});

test("project service pod honors a requested non-root runAsUser/runAsGroup/fsGroup", () => {
  const pod = buildProjectServicePod("test", "cell-1", {
    name: "db",
    image: "postgres:16-alpine",
    runAsUser: 70,
    runAsGroup: 70,
    fsGroup: 70,
  }) as any;
  assert.equal(pod.spec.securityContext.fsGroup, 70);
  assert.equal(pod.spec.containers[0].securityContext.runAsUser, 70);
  assert.equal(pod.spec.containers[0].securityContext.runAsGroup, 70);
  assert.equal(pod.spec.containers[0].securityContext.runAsNonRoot, true);
});

test("project service pod omits user/group overrides when not requested", () => {
  const pod = buildProjectServicePod("test", "cell-1", { name: "db", image: "postgres:16-alpine" }) as any;
  assert.ok(!("fsGroup" in pod.spec.securityContext));
  assert.ok(!("runAsUser" in pod.spec.containers[0].securityContext));
  assert.ok(!("runAsGroup" in pod.spec.containers[0].securityContext));
});

test("project cell ensure is single-flight across concurrent callers", async () => {
  const controller = new FakeProjectCellController();
  controller.delayMs = 10;
  const backend = new MockSandboxBackend();
  const manager = new ProjectCellManager(controller, backend, [projectCellClass()]);

  const [first, second] = await Promise.all([manager.ensure({ id: "cell-1" }), manager.ensure({ id: "cell-1" })]);
  assert.equal(first.executor.id, second.executor.id);
  assert.equal(backend.creates, 1, "concurrent ensure must create exactly one executor sandbox");
});

test("project cell ensure rolls back a half-built cell when a service never becomes ready", async () => {
  const controller = new FakeProjectCellController();
  controller.failWait = true;
  const backend = new MockSandboxBackend();
  const manager = new ProjectCellManager(controller, backend, [projectCellClass()]);

  await assert.rejects(
    manager.ensure({ id: "cell-1", services: [{ name: "db", image: "postgres:16-alpine" }] }),
    /not ready/,
  );
  assert.deepEqual(controller.deleted, ["synth-cell-cell-1"], "failed ensure must delete the leaked namespace");

  // A failed ensure must not poison the cell id: a later attempt can still succeed.
  controller.failWait = false;
  const handle = await manager.ensure({ id: "cell-1", services: [{ name: "db", image: "postgres:16-alpine" }] });
  assert.equal(handle.id, "cell-1");
  assert.equal(backend.creates, 1);
});

test("project cell ensure does not delete a caller-provided namespace on failure", async () => {
  const controller = new FakeProjectCellController();
  controller.failWait = true;
  const backend = new MockSandboxBackend();
  const manager = new ProjectCellManager(controller, backend, [projectCellClass()]);

  await assert.rejects(
    manager.ensure({ id: "cell-1", namespace: "shared-ns", services: [{ name: "db", image: "postgres:16-alpine" }] }),
    /not ready/,
  );
  assert.deepEqual(controller.deleted, [], "must not delete a namespace the caller supplied");
});

test("project cell destroy waits for an in-flight create before tearing down", async () => {
  const controller = new FakeProjectCellController();
  controller.delayMs = 10;
  const backend = new MockSandboxBackend();
  const manager = new ProjectCellManager(controller, backend, [projectCellClass()]);

  const creating = manager.ensure({ id: "cell-1" });
  await manager.destroy("cell-1");
  await creating;
  assert.equal(backend.destroys, 1);
  assert.deepEqual(controller.deleted, ["synth-cell-cell-1"]);
});

test("project cell reap cannot delete a namespace a concurrent lease just recreated", async () => {
  const controller = new FakeProjectCellController();
  let releaseDestroy!: () => void;
  const destroyGate = new Promise<void>((resolve) => { releaseDestroy = resolve; });
  class GatedDestroyBackend extends MockSandboxBackend {
    override async destroy(): Promise<void> {
      await destroyGate;
      return super.destroy();
    }
  }
  const backend = new GatedDestroyBackend();
  const manager = new ProjectCellManager(controller, backend, [projectCellClass()]);
  const spec = { id: "cell-1", idleTtlMs: 0 };
  await manager.ensure(spec);

  // reap decides the cell is idle and enters destroy, then blocks on the gate.
  const reaping = manager.reap(Date.now() + 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A lease arrives while destroy is in flight; it must not end up pointing at
  // a namespace the stale destroy then deletes (same derived namespace name).
  const leasing = manager.lease(spec);
  releaseDestroy();
  const lease = await leasing;
  await reaping;

  assert.ok(
    controller.activeNamespaces.has(lease.handle.namespace),
    "the leased cell's namespace must still exist after a concurrent reap",
  );
});

test("project cell reap destroys only idle, unleased cells", async () => {
  const controller = new FakeProjectCellController();
  const backend = new MockSandboxBackend();
  const manager = new ProjectCellManager(controller, backend, [projectCellClass()]);

  const spec = { id: "cell-1", idleTtlMs: 1_000 };
  await manager.ensure(spec);
  const lease = await manager.lease(spec);
  await manager.reap(Date.now() + 5_000);
  assert.equal(backend.destroys, 0, "a leased cell must not be reaped");
  await lease.release();
  await manager.reap(Date.now() + 5_000);
  assert.equal(backend.destroys, 1);
  assert.deepEqual(controller.deleted, ["synth-cell-cell-1"]);
});

test("sandbox manifest omits an empty runtimeClassName instead of emitting an invalid pod", () => {
  const cls = { ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0]!, runtimeClassName: "" };
  const pod = buildSandboxPod("test", "pod", "sandbox", cls) as any;
  assert.ok(!("runtimeClassName" in pod.spec) || pod.spec.runtimeClassName === undefined);
});

test("pod+NetworkPolicy delete uses type/name form so both resources are actually targeted", () => {
  // `kubectl delete pod X networkpolicy Y` is NOT "delete pod X and
  // networkpolicy Y": kubectl treats every token after the first resource
  // type as another name of THAT type, so it tries to delete pods named X,
  // "networkpolicy", and Y, and the real NetworkPolicy is never touched.
  // With --ignore-not-found the bogus lookups fail silently (exit 0), so
  // the leak is invisible unless you inspect the exact argv. Verified live
  // against a real cluster: bare "pod X networkpolicy Y" leaks the policy,
  // "pod/X networkpolicy/Y" deletes both.
  const args = deletePodAndPolicyArgs("agent-7", "synth-sandboxes");
  assert.deepEqual(args, [
    "delete",
    "pod/agent-7",
    "networkpolicy/agent-7-network",
    "-n",
    "synth-sandboxes",
    "--ignore-not-found=true",
    "--wait=false",
  ]);
  assert.ok(!args.includes("pod"), "must not pass bare 'pod' as a resource type followed by extra name-only tokens");
  assert.ok(!args.includes("networkpolicy"), "must not pass bare 'networkpolicy' as a second name under the 'pod' type");
});
