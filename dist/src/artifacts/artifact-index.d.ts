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
     * Walk the `producedFrom` chain backwards from `digest`, returning every
     * reachable digest (including the start). Depth-limited and cycle-safe.
     */
    walkProvenance(digest: string, maxDepth?: number): string[];
}
