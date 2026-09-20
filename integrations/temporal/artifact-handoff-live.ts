/**
 * 2c part two live proof: hand an artifact onward by REFERENCE.
 *
 * Agent A (one workflow) produces an artifact; agent B (a DIFFERENT workflow)
 * receives only the reference by signal, reads exactly those bytes by digest
 * from the shared blob store, and derives a new artifact whose `producedFrom`
 * points back at A. The proof asserts the provenance chain is walkable AND that
 * the Temporal history size stays FLAT across two very different artifact sizes
 * (1 KiB vs 4 MiB) — the assertion that actually tests "never inline content",
 * since a bytes-match check alone would pass on an inlining implementation.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx artifact-handoff-live.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { FileSystemBlobStore, InMemoryArtifactIndex, digestOf } from "../../src/index.js";
import { runTemporalWorker } from "./src/worker.js";
import { consumerWorkflow, deliverArtifact, producerWorkflow, type ArtifactRef } from "./test/fixtures/handoff-probe.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-handoff-${Date.now()}`;
const SIZES = [1 * 1024, 4 * 1024 * 1024]; // 1 KiB vs 4 MiB
const FLAT_TOLERANCE_BYTES = 4 * 1024; // histories may differ by small scheduling metadata

const root = await mkdtemp(join(tmpdir(), "synth-handoff-"));
const store = new FileSystemBlobStore(root);
const index = new InMemoryArtifactIndex();
const inputBytes = new TextEncoder().encode("agent-A input");
const inputDigest = digestOf(inputBytes);
index.record({ digest: inputDigest, size: inputBytes.byteLength, mediaType: "text/plain", mechanism: "blob-store", producedBy: "agent-0" });

function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
}

const activities = {
  async produce(size: number): Promise<ArtifactRef> {
    const ref = await store.put(payload(size), { mediaType: "application/octet-stream", producedBy: "agent-A", producedFrom: [inputDigest] });
    index.record(ref);
    return ref;
  },
  async consume(ref: ArtifactRef) {
    const bytes = await store.get(ref.digest);
    return { digest: ref.digest, size: ref.size, matches: digestOf(bytes) === ref.digest && bytes.byteLength === ref.size, bytes: bytes.byteLength };
  },
  async derive(ref: ArtifactRef): Promise<ArtifactRef> {
    const derived = await store.put(new TextEncoder().encode(`derived:${ref.digest}`), { mediaType: "text/plain", producedBy: "agent-B", producedFrom: [ref.digest] });
    index.record(derived);
    return derived;
  },
};

void runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./test/fixtures/handoff-probe.ts", import.meta.url)),
  activities,
  taskQueue,
  address,
  namespace,
}).catch((error) => {
  console.error("worker failed", error);
  process.exit(1);
});

await sleep(2_500);
const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const stamp = Date.now();

/**
 * Size of the workflow history as seen on the wire, proxied by the encoded
 * event payloads. A reference is a few hundred bytes regardless of artifact
 * size; an implementation that inlined content would scale with the artifact.
 */
function historyBytes(history: { events?: unknown[] }): number {
  return (history.events ?? []).reduce<number>((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
}

const results: Array<{ size: number; producerHistoryBytes: number; consumerHistoryBytes: number; digest: string; derivedFrom: string[] }> = [];
let ok = true;

for (const size of SIZES) {
  const handleA = await client.workflow.start("producerWorkflow", { taskQueue, workflowId: `handoff-a-${size}-${stamp}`, args: [size] });
  const refA = await handleA.result();
  const sizeA = historyBytes(await handleA.fetchHistory());

  const handleB = await client.workflow.start("consumerWorkflow", { taskQueue, workflowId: `handoff-b-${size}-${stamp}` });
  await handleB.signal(deliverArtifact, refA);
  const refB = await handleB.result();
  const sizeB = historyBytes(await handleB.fetchHistory());

  const bytesMatch = refA.digest === digestOf(payload(size)) && refA.size === size;
  const derivedFrom = refB.producedFrom ?? [];
  const chain = index.walkProvenance(refB.digest);
  const chainDigests = chain.nodes.map((node) => node.digest);
  const provenanceWalkable = chain.intact && chainDigests.includes(refA.digest) && chainDigests.includes(inputDigest);
  if (!bytesMatch || !derivedFrom.includes(refA.digest) || !provenanceWalkable) ok = false;
  results.push({ size, producerHistoryBytes: sizeA, consumerHistoryBytes: sizeB, digest: refA.digest, derivedFrom });
}

const small = results[0]!;
const large = results[1]!;
const producerFlat = Math.abs(large.producerHistoryBytes - small.producerHistoryBytes) <= FLAT_TOLERANCE_BYTES;
const consumerFlat = Math.abs(large.consumerHistoryBytes - small.consumerHistoryBytes) <= FLAT_TOLERANCE_BYTES;
const flat = producerFlat && consumerFlat;
if (!flat) ok = false;

console.log(
  JSON.stringify(
    {
      address,
      sizes: SIZES,
      results,
      history: {
        producer: { small: small.producerHistoryBytes, large: large.producerHistoryBytes, delta: large.producerHistoryBytes - small.producerHistoryBytes },
        consumer: { small: small.consumerHistoryBytes, large: large.consumerHistoryBytes, delta: large.consumerHistoryBytes - small.consumerHistoryBytes },
        flatToleranceBytes: FLAT_TOLERANCE_BYTES,
        flat,
      },
      artifactSizeDelta: large.size - small.size,
      ok,
    },
    null,
    2,
  ),
);
await connection.close();
await rm(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
