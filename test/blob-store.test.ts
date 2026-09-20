/**
 * Artifact-egress mechanism 4: content-addressed blob store.
 * Receipts carry a sha256 digest; content travels out of band.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionBroker, FileSystemBlobStore, MemoryWorkspace, SyntheticExecutor, sha256Hex } from "../src/index.js";

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(path);
    }
  }
  await walk(dir);
  return out;
}

test("put/get round-trips and the digest is the content's sha256", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-"));
  try {
    const store = new FileSystemBlobStore(root);
    const bytes = new TextEncoder().encode("hello blob");
    const ref = await store.put(bytes, { mediaType: "text/plain" });
    assert.equal(ref.digest, `sha256:${sha256Hex(bytes)}`);
    assert.equal(ref.size, bytes.byteLength);
    assert.equal(ref.mechanism, "blob-store");
    assert.equal(Buffer.from(await store.get(ref.digest)).toString("utf8"), "hello blob");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identical content stored twice yields one object", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-"));
  try {
    const store = new FileSystemBlobStore(root);
    const bytes = new TextEncoder().encode("same content");
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    assert.equal(first.digest, second.digest);
    const objects = (await listFiles(root)).filter((path) => /[a-f0-9]{64}$/.test(path));
    assert.equal(objects.length, 1, "exactly one content object on disk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupted object is detected on read", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-"));
  try {
    const store = new FileSystemBlobStore(root);
    const ref = await store.put(new TextEncoder().encode("original"));
    const [path] = await listFiles(root);
    await writeFile(path!, "tampered");
    await assert.rejects(store.get(ref.digest), /BLOB_CORRUPT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stat round-trips the media type", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-"));
  try {
    const store = new FileSystemBlobStore(root);
    const bytes = new TextEncoder().encode("report");
    const ref = await store.put(bytes, { mediaType: "text/markdown" });
    assert.equal((await store.stat(ref.digest))?.mediaType, "text/markdown", "mediaType survives put/stat");
    assert.ok(Buffer.from(await store.get(ref.digest)).equals(Buffer.from(bytes)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("KNOWN OPEN: no runtime path populates EffectResult.artifact yet", async () => {
  // The egress spec requires an effect receipt to carry a digest that resolves
  // to the bytes. No writer sets `EffectResult.artifact`, so this pins the gap:
  // it fails the day a writer lands, and the known-open entry is then removed
  // deliberately rather than the gap being silently forgotten.
  const workspace = new MemoryWorkspace();
  const broker = new ExecutionBroker([new SyntheticExecutor(new Map([[workspace.id, workspace]]))]);
  const result = await broker.execute(
    { id: "e-artifact", kind: "workspace.write", path: "a.txt", content: "x" },
    { agentId: "agt_blob" as never, workspaceId: workspace.id },
  );
  assert.equal(result.ok, true);
  assert.equal(result.artifact, undefined, "no writer populates EffectResult.artifact yet");
});

test("stat reports the object, a missing digest is undefined, an invalid one throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-"));
  try {
    const store = new FileSystemBlobStore(root);
    const ref = await store.put(new TextEncoder().encode("x"));
    assert.equal((await store.stat(ref.digest))?.size, 1);
    assert.equal(await store.stat(`sha256:${"0".repeat(64)}`), undefined);
    await assert.rejects(store.get("not-a-digest"), /Invalid blob digest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
