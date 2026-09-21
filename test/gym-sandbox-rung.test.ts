/**
 * One rung: the gym's `runner=sandbox` arm executes EVERY effect — workspace
 * read/write/replace/list and process.exec — inside the pod, not in worker RAM.
 *
 * Before this, `integrations/gym/sandbox.ts` built its own
 * `ExecutionBroker([SyntheticExecutor, KubernetesExecutor])`: workspace effects
 * ran in a host `MemoryWorkspace` and only `process.exec` reached the pod. This
 * test injects a fake "pod" backend into the real `buildSandboxRunner` and
 * asserts the executor id and that the host checkout/RAM is not the medium.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KubernetesResourceClass } from "../src/execution/resource-class.js";
import type { SandboxBackend, SandboxExecRequest, SandboxExecResult, SandboxIdentity } from "../src/execution/kubernetes/types.js";
import { FileSystemBlobStore } from "../src/index.js";
import { buildSandboxRunner } from "../integrations/gym/sandbox.js";

/** Stand-in for the executor Pod: an in-memory filesystem plus the exact exec commands issued. */
class FakeSandboxBackend implements SandboxBackend {
  readonly files = new Map<string, Uint8Array>();
  readonly symlinks = new Map<string, string>();
  readonly dirs = new Set<string>([""]);
  readonly calls = { create: 0, destroy: 0, exec: 0, readFile: 0, writeFile: 0, writeSymlink: 0, readSymlink: 0, removePath: 0 };
  #nextId = 0;

  async create(resourceClass: KubernetesResourceClass): Promise<SandboxIdentity> {
    this.calls.create++;
    const id = `pod-${++this.#nextId}`;
    return { id, namespace: "fake", podName: id, resourceClassId: resourceClass.id, createdAt: Date.now() };
  }
  async destroy(): Promise<void> { this.calls.destroy++; }
  async reset(): Promise<void> { this.files.clear(); this.symlinks.clear(); this.dirs.clear(); this.dirs.add(""); }
  async verifyReset(): Promise<boolean> { return true; }
  async exec(_sandbox: SandboxIdentity, request: SandboxExecRequest): Promise<SandboxExecResult> {
    this.calls.exec++;
    const command = request.command;
    if (command.includes("echo D") && command.includes("echo N")) {
      const path = /p='([^']*)'/.exec(command)?.[1] ?? "";
      if (this.dirs.has(path)) return { exitCode: 0, stdout: "D\n", stderr: "" };
      if (this.files.has(path)) return { exitCode: 0, stdout: "F\n", stderr: "" };
      return { exitCode: 0, stdout: "N\n", stderr: "" };
    }
    if (command.includes("find . -mindepth 1 -maxdepth 1")) {
      const dir = /cd '([^']*)'/.exec(command)?.[1] ?? ".";
      const base = dir === "." ? "" : dir;
      const prefix = base ? `${base}/` : "";
      const out: string[] = [];
      for (const d of this.dirs) {
        if (d !== base && d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) out.push(`${d.slice(prefix.length)}/d`);
      }
      for (const f of this.files.keys()) {
        if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) out.push(`${f.slice(prefix.length)}/f`);
      }
      return { exitCode: 0, stdout: `${out.sort().join("\n")}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: `ran:${command}`, stderr: "" };
  }
  async writeFile(_sandbox: SandboxIdentity, path: string, content: Uint8Array): Promise<void> {
    this.calls.writeFile++;
    this.files.set(path, content.slice());
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }
  async readFile(_sandbox: SandboxIdentity, path: string): Promise<Uint8Array> {
    this.calls.readFile++;
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`ENOENT ${path}`);
    return bytes.slice();
  }
  async writeSymlink(_sandbox: SandboxIdentity, path: string, target: string): Promise<void> {
    this.calls.writeSymlink++;
    this.symlinks.set(path, target);
  }
  async readSymlink(_sandbox: SandboxIdentity, path: string): Promise<string> {
    this.calls.readSymlink++;
    const target = this.symlinks.get(path);
    if (target === undefined) throw new Error(`ENOENT ${path}`);
    return target;
  }
  async removePath(_sandbox: SandboxIdentity, path: string): Promise<void> {
    this.calls.removePath++;
    this.files.delete(path);
    this.symlinks.delete(path);
    this.dirs.delete(path);
  }
  async listGitChanges(): Promise<Array<{ path: string; deleted: boolean; symlink?: boolean }>> {
    return [
      ...[...this.files.keys()].map((path) => ({ path, deleted: false })),
      ...[...this.symlinks.keys()].map((path) => ({ path, deleted: false, symlink: true })),
    ];
  }
}

test("the gym sandbox runner runs workspace effects (and replace) in the pod, not host RAM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gym-rung-"));
  const repoDir = join(dir, "repo");
  const hostSentinel = join(dir, "sentinel.txt");
  await mkdir(repoDir, { recursive: true });
  await writeFile(join(repoDir, "he.js"), "codePoint = parseInt(hexDigits, 10);\n");
  await writeFile(hostSentinel, "host-untouched");
  const backend = new FakeSandboxBackend();
  const sandbox = await buildSandboxRunner({ repoDir, image: "unused", backend, agentId: "agt_rung" });
  try {
    // A read from the SOURCE executes on the pod executor, not the synthetic one.
    const read = await sandbox.executeEffect({ id: "r", kind: "workspace.read", path: "he.js" });
    assert.equal(read.ok, true, read.error);
    assert.equal(read.executor, "sandbox-workspace:sandbox-small", "workspace effects must run on the pod executor");
    assert.notEqual(read.executor, "synthetic", "no host-RAM executor on the sandbox path");
    assert.equal(backend.calls.create, 1, "one persistent pod for the workspace");
    assert.ok(backend.calls.readFile >= 1, "the read reached the pod backend");

    // The runner's read path decodes the pod bytes to text (not comma-joined).
    assert.equal(await sandbox.runner.read("he.js"), "codePoint = parseInt(hexDigits, 10);\n");

    // A write lands in the pod and does NOT touch the host checkout or a host file.
    await sandbox.runner.write("out.txt", "pod-only");
    assert.equal(backend.files.has("out.txt"), true, "the write landed in the pod");
    assert.equal(await readFile(hostSentinel, "utf8"), "host-untouched");
    assert.equal(await readFile(join(repoDir, "he.js"), "utf8"), "codePoint = parseInt(hexDigits, 10);\n", "the host checkout was not the medium");

    // workspace.replace runs in the pod and the edit is visible to a later read.
    const replaced = await sandbox.executeEffect({ id: "p", kind: "workspace.replace", path: "he.js", oldText: "parseInt(hexDigits, 10)", newText: "parseInt(hexDigits, 16)" });
    assert.equal(replaced.ok, true, replaced.error);
    assert.equal(replaced.executor, "sandbox-workspace:sandbox-small");
    assert.equal(await sandbox.runner.read("he.js"), "codePoint = parseInt(hexDigits, 16);\n");

    // The host checkout is still the bugged original: the pod held the edit.
    assert.equal(await readFile(join(repoDir, "he.js"), "utf8"), "codePoint = parseInt(hexDigits, 10);\n");

    await sandbox.close();
    assert.equal(backend.calls.destroy, 1, "close destroys the pod");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cold sandbox runner restores the checkpointed workspace (work survives a worker restart)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gym-rung-cp-"));
  try {
    const repoDir = join(dir, "repo");
    const BUGGY = "codePoint = parseInt(hexDigits, 10);\n";
    const FIXED = "codePoint = parseInt(hexDigits, 16);\n";
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "he.js"), BUGGY);
    const blobs = new FileSystemBlobStore(join(dir, "blobs"));

    // Worker A: the agent edits in the pod, the turn commits, and the workspace
    // is checkpointed into the blob store before the pod is destroyed.
    const backendA = new FakeSandboxBackend();
    const sandboxA = await buildSandboxRunner({ repoDir, image: "unused", backend: backendA, agentId: "agt_cp" });
    const replaced = await sandboxA.executeEffect({
      id: "p",
      kind: "workspace.replace",
      path: "he.js",
      oldText: "parseInt(hexDigits, 10)",
      newText: "parseInt(hexDigits, 16)",
    });
    assert.equal(replaced.ok, true, replaced.error);
    assert.equal(await sandboxA.runner.read("he.js"), FIXED, "the edit is in the pod");
    const digest = await sandboxA.checkpointWorkspace(blobs);
    assert.ok(digest, "checkpointing a live pod must return a durable digest");
    await sandboxA.close();

    // Control: a cold pod WITHOUT the checkpoint starts from the bugged source,
    // so the test below is discriminating (the loss is observable).
    const backendCold = new FakeSandboxBackend();
    const cold = await buildSandboxRunner({ repoDir, image: "unused", backend: backendCold, agentId: "agt_cp" });
    assert.equal(await cold.runner.read("he.js"), BUGGY, "without a restore the cold pod re-materializes the bugged base");
    await cold.close();

    // Worker B: a cold worker restores from the digest, and the resumed pod
    // holds the committed edit. The digest is the content reference in the SAME
    // store, not process memory.
    const backendB = new FakeSandboxBackend();
    const resumed = await buildSandboxRunner({
      repoDir,
      image: "unused",
      backend: backendB,
      agentId: "agt_cp",
      restore: { blobStore: blobs, digest: digest! },
    });
    assert.equal(await resumed.runner.read("he.js"), FIXED, "the resumed pod must hold the checkpointed edit");
    const stat = await blobs.stat(digest!);
    assert.ok(stat && stat.size > 0, "the workspace digest resolves to bytes in the same blob store");
    await resumed.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
