/**
 * Blob retention: prune down to the artifact index's reachable set, including
 * the `producedFrom` ancestry, so a missing index entry cannot cause a
 * still-referenced blob to be deleted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemBlobStore, InMemoryArtifactIndex, reachableDigests, sweepUnreferencedBlobs } from "../src/index.js";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

test("sweep prunes only what the index cannot reach, and keeps the provenance chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-gc-"));
  try {
    const store = new FileSystemBlobStore(root);
    const index = new InMemoryArtifactIndex();
    const parent = await store.put(enc("parent"), { mediaType: "text/plain", producedBy: "a" });
    index.record(parent);
    const child = await store.put(enc("child"), { mediaType: "text/plain", producedBy: "b", producedFrom: [parent.digest] });
    index.record(child);
    const orphan = await store.put(enc("orphan"), { mediaType: "text/plain", producedBy: "z" });

    const reachable = reachableDigests(index);
    assert.ok(reachable.has(parent.digest) && reachable.has(child.digest), "recorded artifacts are reachable");
    assert.equal(reachable.has(orphan.digest), false, "an unrecorded blob is not reachable");

    const result = await sweepUnreferencedBlobs({ store, index });
    assert.deepEqual(result.removed, [orphan.digest]);
    assert.equal(result.freedBytes, orphan.size);
    assert.equal(new TextDecoder().decode(await store.get(parent.digest)), "parent");
    assert.equal(new TextDecoder().decode(await store.get(child.digest)), "child");
    await assert.rejects(store.get(orphan.digest), /ENOENT|BLOB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a referenced-but-unrecorded ancestor is kept, and a grace period spares the young", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-gc2-"));
  try {
    const store = new FileSystemBlobStore(root);
    const index = new InMemoryArtifactIndex();
    const ghost = await store.put(enc("ghost"), { mediaType: "text/plain" });
    const child = await store.put(enc("child"), { mediaType: "text/plain", producedFrom: [ghost.digest] });
    index.record(child);
    const orphan = await store.put(enc("orphan"), { mediaType: "text/plain" });

    assert.ok(reachableDigests(index).has(ghost.digest), "an ancestor named by producedFrom is kept even without its own record");

    const graced = await sweepUnreferencedBlobs({ store, index, olderThanMs: 60_000 });
    assert.equal(graced.removed.includes(orphan.digest), false, "a young orphan survives the grace period");
    assert.equal(graced.removed.includes(ghost.digest), false);

    const hard = await sweepUnreferencedBlobs({ store, index });
    assert.deepEqual(hard.removed, [orphan.digest]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
