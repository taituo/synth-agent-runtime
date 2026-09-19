import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KUBERNETES_RESOURCE_CLASSES, ExecutionBroker, KubernetesExecutor, MemoryWorkspace, WarmSandboxPool, WorkspaceSynchronizer, buildSandboxNetworkPolicy, buildProjectServicePod, buildSandboxPod, deletePodAndPolicyArgs, } from "../src/index.js";
class MockSandboxBackend {
    creates = 0;
    resets = 0;
    destroys = 0;
    files = new Map();
    baseline = new Map();
    async create(resourceClass, options = {}) {
        this.creates++;
        return {
            id: `sandbox-${this.creates}`,
            namespace: options.namespace ?? "test",
            podName: `pod-${this.creates}`,
            resourceClassId: resourceClass.id,
            createdAt: Date.now(),
        };
    }
    async destroy() { this.destroys++; }
    async reset() { this.resets++; this.files.clear(); this.baseline.clear(); }
    async exec(_sandbox, request) {
        if (request.command.includes("git init"))
            this.baseline = cloneMap(this.files);
        if (request.command === "mutate")
            this.files.set("a.txt", new TextEncoder().encode("physical"));
        return { exitCode: 0, stdout: "ok", stderr: "" };
    }
    async writeFile(_sandbox, path, content) { this.files.set(path, content.slice()); }
    async readFile(_sandbox, path) {
        const value = this.files.get(path);
        if (!value)
            throw new Error(`missing ${path}`);
        return value.slice();
    }
    async removePath(_sandbox, path) { this.files.delete(path); }
    async listGitChanges() {
        const paths = new Set([...this.files.keys(), ...this.baseline.keys()]);
        const changes = [];
        for (const path of [...paths].sort()) {
            const a = this.baseline.get(path);
            const b = this.files.get(path);
            if (!same(a, b))
                changes.push({ path, deleted: b === undefined });
        }
        return changes;
    }
}
function cloneMap(input) {
    return new Map([...input].map(([k, v]) => [k, v.slice()]));
}
function same(a, b) {
    if (!a || !b)
        return a === b;
    return a.length === b.length && a.every((value, i) => value === b[i]);
}
class TinySource {
    name = "tiny";
    files = new Map([["a.txt", new TextEncoder().encode("base")]]);
    async revision() { return { kind: "snapshot" }; }
    async stat(path) {
        if (path === "")
            return { path, kind: "directory", size: 0, mtimeMs: 0 };
        const value = this.files.get(path);
        return value ? { path, kind: "file", size: value.length, mtimeMs: 0 } : undefined;
    }
    async listDir() { return [{ path: "a.txt", kind: "file", size: 4, mtimeMs: 0 }]; }
    async readFile(path) { return this.files.get(path).slice(); }
    async *listFiles() { yield "a.txt"; }
}
test("sandbox manifest uses restricted isolation and gVisor", () => {
    const cls = DEFAULT_KUBERNETES_RESOURCE_CLASSES[0];
    const pod = buildSandboxPod("test", "pod", "sandbox", cls);
    assert.equal(pod.spec.runtimeClassName, "gvisor");
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(pod.spec.securityContext.runAsNonRoot, true);
    assert.equal(pod.spec.securityContext.seccompProfile.type, "RuntimeDefault");
    const container = pod.spec.containers[0];
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
    assert.equal(container.resources.limits.memory, "4Gi");
    const network = buildSandboxNetworkPolicy("test", "network", "sandbox", cls.network);
    assert.deepEqual(network.spec.policyTypes, ["Ingress", "Egress"]);
    assert.ok(network.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 53)));
    assert.ok(network.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 3128)));
    assert.equal(JSON.stringify(network).includes("0.0.0.0/0"), false);
});
test("warm pool reuses a reset sandbox", async () => {
    const backend = new MockSandboxBackend();
    const cls = { ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0], warmPool: { minReady: 1, maxReady: 1, maxTotal: 2, idleTtlMs: 60_000 } };
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
    const cls = { ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0], warmPool: undefined };
    const workspace = new MemoryWorkspace({ source: new TinySource() });
    const workspaces = new Map([[workspace.id, workspace]]);
    const executor = new KubernetesExecutor({ resourceClass: cls, backend, workspaces });
    const effect = { id: "e1", kind: "process.exec", command: "mutate", resourceClass: cls.id };
    const context = { agentId: "agent-1", workspaceId: workspace.id };
    const result = await executor.execute(effect, context);
    assert.equal(result.ok, true);
    assert.equal(await workspace.readText("a.txt"), "physical");
    assert.equal(backend.destroys, 1);
});
test("broker honors preferred resource class transparently", async () => {
    const called = [];
    const make = (id, fidelity) => ({
        id: `x:${id}`,
        resourceClassId: id,
        fidelity,
        canExecute: () => true,
        execute: async () => { called.push(id); return { ok: true, output: id }; },
    });
    const broker = new ExecutionBroker([make("sandbox-small", 20), make("sandbox-medium", 30)]);
    const result = await broker.execute({ id: "e", kind: "process.exec", command: "true" }, {
        agentId: "a",
        workspaceId: "w",
        executionPolicy: { preferredClass: "sandbox-medium", allowedClasses: ["sandbox-small", "sandbox-medium"] },
    });
    assert.equal(result.output, "sandbox-medium");
    assert.deepEqual(called, ["sandbox-medium"]);
});
test("warm pool destroys a sandbox when reset verification fails", async () => {
    class FailingVerifyBackend extends MockSandboxBackend {
        async verifyReset() { return false; }
    }
    const backend = new FailingVerifyBackend();
    const cls = { ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0], warmPool: { minReady: 0, maxReady: 1, maxTotal: 1, idleTtlMs: 60_000 } };
    const pool = new WarmSandboxPool(backend, [cls]);
    const lease = await pool.acquire(cls.id);
    await lease.release();
    assert.equal(backend.resets, 1);
    assert.equal(backend.destroys, 1);
    await pool.close();
});
test("warm pool does not double-lease a slot created while another caller is waiting", async () => {
    let releaseCreate;
    const createGate = new Promise((resolve) => { releaseCreate = resolve; });
    class SlowCreateBackend extends MockSandboxBackend {
        async create(resourceClass, options = {}) {
            await createGate;
            return super.create(resourceClass, options);
        }
    }
    const backend = new SlowCreateBackend();
    const cls = {
        ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0],
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
        ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0],
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
        async listGitChanges() {
            return [
                { path: "first.txt", deleted: false },
                { path: "huge.txt", deleted: false },
            ];
        }
        async readFile(_sandbox, path) {
            return new TextEncoder().encode(path === "first.txt" ? "small" : "x".repeat(64));
        }
    }
    const backend = new OversizeBackend();
    const workspace = new MemoryWorkspace();
    workspace.write("existing.txt", "keep");
    const sync = new WorkspaceSynchronizer(backend, { maxBytes: 16, maxFiles: 10 });
    const sandbox = {
        id: "s", namespace: "n", podName: "p", resourceClassId: "sandbox-small", createdAt: 1,
    };
    await assert.rejects(sync.syncBack(workspace, sandbox), /byte limit/);
    assert.equal(await workspace.readText("existing.txt"), "keep");
    assert.equal(await workspace.readText("first.txt"), undefined);
    assert.equal(await workspace.readText("huge.txt"), undefined);
});
test("project service pod carries a requested RuntimeClass", () => {
    const pod = buildProjectServicePod("test", "cell-1", {
        name: "db",
        image: "postgres:16-alpine",
        runtimeClassName: "gvisor",
    });
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
        });
        assert.ok(!("runtimeClassName" in pod.spec) || pod.spec.runtimeClassName === undefined, `runtimeClassName must be omitted when ${JSON.stringify(runtimeClassName)}`);
    }
});
test("sandbox manifest omits an empty runtimeClassName instead of emitting an invalid pod", () => {
    const cls = { ...DEFAULT_KUBERNETES_RESOURCE_CLASSES[0], runtimeClassName: "" };
    const pod = buildSandboxPod("test", "pod", "sandbox", cls);
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
