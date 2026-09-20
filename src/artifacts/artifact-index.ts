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
   * Walk the `producedFrom` chain backwards from `digest`. Depth-limited and
   * cycle-safe.
   *
   * Returns a report, not a bare digest list: a bare list cannot distinguish an
   * intact chain from a broken one (a digest named by `producedFrom` but never
   * recorded looks identical to a recorded ancestor), nor a known root from an
   * unknown digest — both would silently give false confidence. `gaps` names
   * every referenced-but-unknown digest and `intact` is true only when the walk
   * completed with no gaps.
   */
  walkProvenance(digest: string, maxDepth = 32): ProvenanceReport {
    const seen = new Set<string>();
    const nodes: ProvenanceNode[] = [];
    const gaps: string[] = [];
    let truncated = false;
    const stack: Array<{ id: string; depth: number }> = [{ id: digest, depth: 0 }];
    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      if (seen.has(id)) continue;
      if (depth > maxDepth) {
        truncated = true;
        continue;
      }
      seen.add(id);
      const record = this.#byDigest.get(id);
      if (record) nodes.push({ digest: id, known: true, record });
      else {
        nodes.push({ digest: id, known: false });
        gaps.push(id);
      }
      for (const input of record?.ref.producedFrom ?? []) stack.push({ id: input, depth: depth + 1 });
    }
    return { nodes, gaps, truncated, intact: gaps.length === 0 && !truncated };
  }
}

export interface ProvenanceNode {
  digest: string;
  /** True when this digest has a record in the index. */
  known: boolean;
  record?: ArtifactRecord;
}

export interface ProvenanceReport {
  nodes: ProvenanceNode[];
  /** Digests referenced by `producedFrom` but with no record in the index. */
  gaps: string[];
  /** True when the depth limit stopped the walk early. */
  truncated: boolean;
  /** True only when every reachable ancestor is known and the walk completed. */
  intact: boolean;
}
