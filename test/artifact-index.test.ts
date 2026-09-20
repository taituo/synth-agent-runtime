/**
 * Part two: provenance on the reference and a small artifact index. A handoff
 * passes a reference; the index makes discovery and the provenance chain
 * walkable without knowing a digest in advance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemBlobStore, InMemoryArtifactIndex, digestOf, type BlobRef } from "../src/index.js";

function ref(digest: string, producedBy: string, producedFrom: string[] = []): BlobRef {
  return { digest, size: 1, mediaType: "text/plain", mechanism: "blob-store", producedBy, producedFrom };
}

test("the index is queryable by digest, producer and input digest", () => {
  const index = new InMemoryArtifactIndex();
  const input = digestOf(new TextEncoder().encode("input"));
  const a = digestOf(new TextEncoder().encode("A"));
  const b = digestOf(new TextEncoder().encode("B"));
  index.record(ref(input, "agent-0"));
  index.record(ref(a, "agent-A", [input]));
  index.record(ref(b, "agent-B", [a]));

  assert.equal(index.get(b)?.ref.producedBy, "agent-B");
  assert.deepEqual(index.byProducer("agent-A").map((r) => r.ref.digest), [a]);
  assert.deepEqual(index.byInput(a).map((r) => r.ref.digest), [b]);
});

test("the provenance chain from B back to its input is walkable and cycle-safe", () => {
  const index = new InMemoryArtifactIndex();
  const input = digestOf(new TextEncoder().encode("input"));
  const a = digestOf(new TextEncoder().encode("A"));
  const b = digestOf(new TextEncoder().encode("B"));
  index.record(ref(input, "agent-0"));
  index.record(ref(a, "agent-A", [input]));
  index.record(ref(b, "agent-B", [a]));

  const report = index.walkProvenance(b);
  const digests = report.nodes.map((node) => node.digest);
  assert.ok(digests.includes(b) && digests.includes(a) && digests.includes(input), `chain was ${digests.join(",")}`);
  assert.equal(report.intact, true);
  assert.deepEqual(report.gaps, []);
  assert.ok(report.nodes.every((node) => node.known));

  // A cycle must not loop forever.
  const cyc = new InMemoryArtifactIndex();
  cyc.record(ref("d1", "x", ["d2"]));
  cyc.record(ref("d2", "y", ["d1"]));
  assert.deepEqual(new Set(cyc.walkProvenance("d1").nodes.map((node) => node.digest)), new Set(["d1", "d2"]));
});

test("a broken chain is distinguishable from an intact one, and an unknown root is a gap", () => {
  const input = digestOf(new TextEncoder().encode("input"));
  const a = digestOf(new TextEncoder().encode("A"));
  const b = digestOf(new TextEncoder().encode("B"));

  const intact = new InMemoryArtifactIndex();
  intact.record(ref(input, "agent-0"));
  intact.record(ref(a, "agent-A", [input]));
  intact.record(ref(b, "agent-B", [a]));
  const intactReport = intact.walkProvenance(b);
  assert.equal(intactReport.intact, true);
  assert.deepEqual(intactReport.gaps, []);

  const broken = new InMemoryArtifactIndex();
  broken.record(ref(b, "agent-B", [a])); // `a` is named by producedFrom but never recorded
  const brokenReport = broken.walkProvenance(b);
  assert.equal(brokenReport.intact, false);
  assert.deepEqual(brokenReport.gaps, [a]);
  assert.notDeepEqual(brokenReport.nodes, intactReport.nodes, "broken and intact chains must differ");

  // A digest that was never recorded is a gap, not a known root.
  const unknown = broken.walkProvenance(digestOf(new TextEncoder().encode("never")));
  assert.equal(unknown.intact, false);
  assert.equal(unknown.nodes[0]!.known, false);
  assert.deepEqual(unknown.gaps, [unknown.nodes[0]!.digest]);
});

test("put/stat round-trip provenance through the blob store", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-index-"));
  try {
    const store = new FileSystemBlobStore(root);
    const input = digestOf(new TextEncoder().encode("input"));
    const stored = await store.put(new TextEncoder().encode("derived"), { mediaType: "text/plain", producedBy: "agent-A", producedFrom: [input] });
    const stat = await store.stat(stored.digest);
    assert.equal(stat?.producedBy, "agent-A");
    assert.deepEqual(stat?.producedFrom, [input]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
