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
export declare class InMemoryArtifactIndex {
    #private;
    record(ref: BlobRef, at?: number): ArtifactRecord;
    get(digest: string): ArtifactRecord | undefined;
    byProducer(producedBy: string): ArtifactRecord[];
    /** Artifacts derived from `digest` (their `producedFrom` includes it). */
    byInput(digest: string): ArtifactRecord[];
    list(): ArtifactRecord[];
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
    walkProvenance(digest: string, maxDepth?: number): ProvenanceReport;
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
