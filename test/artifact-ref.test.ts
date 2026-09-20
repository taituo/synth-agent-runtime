/**
 * The blackboard rule: an Artifact carries a REFERENCE, never bytes. The world
 * store is where artifacts land, so it must follow the same rule as the rest of
 * the system.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWorkspaceDiff, digestOf, FileSystemBlobStore, MemoryWorkspace } from "../src/index.js";

test("a workspace artifact carries a reference; the digest resolves to the bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-ref-"));
  try {
    const store = new FileSystemBlobStore(root);
    const workspace = new MemoryWorkspace();
    workspace.write("notes.txt", "hello");

    const artifact = await workspace.exportArtifact(store);
    assert.equal(artifact.type, "workspace-diff");
    assert.equal((artifact as unknown as { data?: unknown }).data, undefined, "no inline data on the artifact");
    assert.equal(artifact.ref.mechanism, "blob-store");
    assert.equal(artifact.ref.size > 0, true);

    const bytes = await store.get(artifact.ref.digest);
    assert.equal(digestOf(bytes), artifact.ref.digest, "the digest is the content's sha256");
    const decoded = decodeWorkspaceDiff(bytes);
    assert.equal(decoded.changes.length, 1);
    assert.equal(decoded.changes[0]!.path, "notes.txt");
    assert.equal(new TextDecoder().decode(decoded.changes[0]!.content!), "hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the inline escape hatch is opt-in and bounded by the snapshot ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-inline-"));
  try {
    const store = new FileSystemBlobStore(root);
    const small = new MemoryWorkspace();
    small.write("a.txt", "small");
    const inlined = await small.exportArtifact(store, { inline: true });
    assert.ok(inlined.inline, "small content may be inlined when asked");
    const referencedBytes = await store.get(inlined.ref.digest);
    assert.equal(inlined.inline!.size, referencedBytes.byteLength);
    assert.deepEqual(Buffer.from(inlined.inline!.dataBase64, "base64"), Buffer.from(referencedBytes), "inline equals the referenced bytes");

    const large = new MemoryWorkspace();
    large.write("big.bin", new Uint8Array(300 * 1024).fill(65));
    await assert.rejects(large.exportArtifact(store, { inline: true }), /INLINE_ARTIFACT_TOO_LARGE/);
    // Without the opt-in it is reference-only, and that always works.
    const referenced = await large.exportArtifact(store);
    assert.equal(referenced.inline, undefined);
    assert.equal((await store.get(referenced.ref.digest)).byteLength > 300 * 1024, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
