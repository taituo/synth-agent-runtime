/**
 * Blob retention: prune the store down to the artifact index's reachable set.
 *
 * The index knows what is still referenced (each record's digest plus its
 * `producedFrom` ancestry). This wires that into `FileSystemBlobStore.prune`,
 * which until now existed untested-by-a-caller with reachability left to the
 * caller. It is deliberately a sweep function rather than a scheduler: the
 * caller decides when to run it (cron, a post-run step), so the module stays
 * deterministic and testable.
 */
import type { InMemoryArtifactIndex } from "./artifact-index.js";
export interface PrunableBlobStore {
    prune(options?: {
        keep?: Iterable<string>;
        olderThanMs?: number;
        now?: () => number;
    }): Promise<{
        removed: string[];
        freedBytes: number;
    }>;
}
/**
 * Every digest the index can still reach: each recorded artifact, plus every
 * ancestor named by `producedFrom` (including referenced-but-unrecorded digests,
 * which are kept so a missing index entry cannot cause its blob to be deleted).
 */
export declare function reachableDigests(index: InMemoryArtifactIndex): Set<string>;
export interface RetentionSweepOptions {
    store: PrunableBlobStore;
    index: InMemoryArtifactIndex;
    /** Spare objects younger than this (a grace period for in-flight writers). */
    olderThanMs?: number;
    now?: () => number;
}
/** Delete every blob the index can no longer reach, reporting what went. */
export declare function sweepUnreferencedBlobs(options: RetentionSweepOptions): Promise<{
    removed: string[];
    freedBytes: number;
}>;
