import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemBlobStore } from "../src/artifacts/blob-store.js";
import { DEFAULT_KUBERNETES_RESOURCE_CLASSES } from "../src/execution/resource-class.js";
import { SandboxWorkspaceExecutor, checkpointSandboxWorkspace, restoreSandboxWorkspace } from "../src/execution/kubernetes/sandbox-workspace.js";
import { MemoryWorkspace } from "../src/workspace/memory-workspace.js";
/**
 * A stand-in for the executor Pod: an in-memory filesystem plus the exact
 * `exec` commands `SandboxWorkspaceExecutor` issues (stat, find). It is the
 * "pod", so a workspace effect that reaches this backend did not run in host RAM.
 */
class FakeSandboxBackend {
    files = new Map();
    dirs = new Set([""]);
    calls = { create: 0, destroy: 0, exec: 0, readFile: 0, writeFile: 0, removePath: 0 };
    #nextId = 0;
    async create(resourceClass) {
        this.calls.create++;
        const id = `pod-${++this.#nextId}`;
        return { id, namespace: "fake", podName: id, resourceClassId: resourceClass.id, createdAt: Date.now() };
    }
    async destroy() { this.calls.destroy++; }
    async reset() { this.files.clear(); this.dirs.clear(); this.dirs.add(""); }
    async verifyReset() { return true; }
    async exec(_sandbox, request) {
        this.calls.exec++;
        const command = request.command;
        if (command.includes("echo D") && command.includes("echo N")) {
            const path = /p='([^']*)'/.exec(command)?.[1] ?? "";
            if (this.dirs.has(path))
                return { exitCode: 0, stdout: "D\n", stderr: "" };
            if (this.files.has(path))
                return { exitCode: 0, stdout: "F\n", stderr: "" };
            return { exitCode: 0, stdout: "N\n", stderr: "" };
        }
        if (command.includes("find . -mindepth 1 -maxdepth 1")) {
            const dir = /cd '([^']*)'/.exec(command)?.[1] ?? ".";
            const base = dir === "." ? "" : dir;
            const prefix = base ? `${base}/` : "";
            const out = [];
            for (const d of this.dirs) {
                if (d !== base && d.startsWith(prefix) && !d.slice(prefix.length).includes("/"))
                    out.push(`${d.slice(prefix.length)}/d`);
            }
            for (const f of this.files.keys()) {
                if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
                    out.push(`${f.slice(prefix.length)}/f`);
            }
            return { exitCode: 0, stdout: `${out.sort().join("\n")}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: `ran:${command}`, stderr: "" };
    }
    async writeFile(_sandbox, path, content) {
        this.calls.writeFile++;
        this.files.set(path, content.slice());
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++)
            this.dirs.add(parts.slice(0, i).join("/"));
    }
    async readFile(_sandbox, path) {
        this.calls.readFile++;
        const bytes = this.files.get(path);
        if (!bytes)
            throw new Error(`ENOENT ${path}`);
        return bytes.slice();
    }
    async removePath(_sandbox, path) {
        this.calls.removePath++;
        this.files.delete(path);
        this.dirs.delete(path);
    }
    async listGitChanges() {
        return [...this.files.keys()].map((path) => ({ path, deleted: false }));
    }
}
const resourceClass = DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small");
const context = (workspaceId) => ({
    agentId: "agt_sandbox",
    workspaceId,
    executionPolicy: { preferredClass: resourceClass.id, allowedClasses: [resourceClass.id], allowEscalation: true },
});
test("the sandbox rung runs workspace read/write/list in the pod, not in host RAM", async () => {
    const backend = new FakeSandboxBackend();
    const workspaceId = "ws_sandbox";
    const cache = new MemoryWorkspace({ id: workspaceId });
    const executor = new SandboxWorkspaceExecutor({
        resourceClass,
        backend,
        workspaces: new Map([[workspaceId, cache]]),
    });
    const hostSentinel = join(await mkdtemp(join(tmpdir(), "synth-host-")), "sentinel.txt");
    await writeFile(hostSentinel, "host-untouched");
    try {
        const ctx = context(workspaceId);
        assert.equal(executor.id, `sandbox-workspace:${resourceClass.id}`);
        const write = await executor.execute({ id: "w1", kind: "workspace.write", path: "src/a.txt", content: "pod-bytes" }, ctx);
        assert.equal(write.ok, true);
        const read = await executor.execute({ id: "r1", kind: "workspace.read", path: "src/a.txt" }, ctx);
        assert.equal(read.ok, true);
        assert.equal(new TextDecoder().decode(read.output), "pod-bytes");
        const list = await executor.execute({ id: "l1", kind: "workspace.list", path: "src" }, ctx);
        assert.deepEqual(list.output, ["a.txt"]);
        // The effects ran on the pod backend, and the host cache/RAM was not the medium.
        assert.equal(backend.calls.writeFile, 1);
        assert.equal(backend.calls.readFile, 1);
        assert.equal(backend.calls.create, 1, "one persistent pod for the workspace");
        assert.equal(await cache.readText("src/a.txt"), undefined, "the write did not land in host RAM");
        assert.equal(await readFile(hostSentinel, "utf8"), "host-untouched");
        // A missing path is WORKSPACE_NOT_FOUND, resolved in the pod.
        const missing = await executor.execute({ id: "r2", kind: "workspace.read", path: "src/nope.txt" }, ctx);
        assert.equal(missing.ok, false);
        assert.match(missing.error ?? "", /WORKSPACE_NOT_FOUND/);
        // Only on checkpoint is the pod synced back into the cache.
        assert.equal(await executor.checkpoint(workspaceId), true);
        assert.equal(await cache.readText("src/a.txt"), "pod-bytes");
        await executor.close();
        assert.equal(backend.calls.destroy, 1);
    }
    finally {
        await rm(hostSentinel, { force: true });
    }
});
test("a checkpointed sandbox workspace is restored from the blob store into a new pod", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-sandbox-ws-"));
    try {
        const blobStore = new FileSystemBlobStore(dir);
        const workspaceId = "ws_restart";
        const backendA = new FakeSandboxBackend();
        const executorA = new SandboxWorkspaceExecutor({
            resourceClass,
            backend: backendA,
            workspaces: new Map([[workspaceId, new MemoryWorkspace({ id: workspaceId })]]),
        });
        await executorA.execute({ id: "w1", kind: "workspace.write", path: "keep.txt", content: "survives-restart" }, context(workspaceId));
        const ref = await checkpointSandboxWorkspace(executorA, workspaceId, blobStore);
        assert.ok(ref, "a live pod checkpoints to a blob reference");
        assert.equal(ref.size > 0, true);
        await executorA.close();
        // "Restart": a fresh worker restores the digest from the blob store and
        // materializes it into a brand-new pod.
        const restoredCache = new MemoryWorkspace({ id: workspaceId });
        await restoreSandboxWorkspace(blobStore, ref.digest, restoredCache);
        assert.equal(await restoredCache.readText("keep.txt"), "survives-restart");
        const backendB = new FakeSandboxBackend();
        const executorB = new SandboxWorkspaceExecutor({
            resourceClass,
            backend: backendB,
            workspaces: new Map([[workspaceId, restoredCache]]),
        });
        const read = await executorB.execute({ id: "r1", kind: "workspace.read", path: "keep.txt" }, context(workspaceId));
        assert.equal(read.ok, true);
        assert.equal(new TextDecoder().decode(read.output), "survives-restart");
        assert.ok(backendB.calls.writeFile >= 1, "the restored state was materialized into the new pod");
        await executorB.close();
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
