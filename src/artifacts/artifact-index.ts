/**
 * Small artifact index (artifact-egress part two). A queryable record of what
 * exists — digest, producer, inputs, time — so discovery does not require
 * knowing a digest in advance. Not a service: an in-memory table.
 */
import type { BlobRef } from "./blob-store.js";

export interface ArtifactRecord {
  ref: BlobRef;
  at: number;
}

export class InMemoryArtifactIndex {
  readonly #byDigest = new Map<string, ArtifactRecord>();

  record(ref: BlobRef, at = Date.now()): ArtifactRecord {
    const record: ArtifactRecord = { ref, at };
    this.#byDigest.set(ref.digest, record);
    return record;
  }

  get(digest: string): ArtifactRecord | undefined {
    return this.#byDigest.get(digest);
  }

  byProducer(producedBy: string): ArtifactRecord[] {
    return [...this.#byDigest.values()].filter((record) => record.ref.producedBy === producedBy);
  }

  /** Artifacts derived from `digest` (their `producedFrom` includes it). */
  byInput(digest: string): ArtifactRecord[] {
    return [...this.#byDigest.values()].filter((record) => record.ref.producedFrom?.includes(digest));
  }

  list(): ArtifactRecord[] {
    return [...this.#byDigest.values()];
  }

  /**
   * Walk the `producedFrom` chain backwards from `digest`, returning every
   * reachable digest (including the start). Depth-limited and cycle-safe.
   */
  walkProvenance(digest: string, maxDepth = 32): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack: Array<{ id: string; depth: number }> = [{ id: digest, depth: 0 }];
    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      if (seen.has(id) || depth > maxDepth) continue;
      seen.add(id);
      out.push(id);
      for (const input of this.#byDigest.get(id)?.ref.producedFrom ?? []) stack.push({ id: input, depth: depth + 1 });
    }
    return out;
  }
}
