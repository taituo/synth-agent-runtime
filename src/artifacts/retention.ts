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
  prune(options?: { keep?: Iterable<string>; olderThanMs?: number; now?: () => number }): Promise<{ removed: string[]; freedBytes: number }>;
}

/**
 * Every digest the index can still reach: each recorded artifact, plus every
 * ancestor named by `producedFrom` (including referenced-but-unrecorded digests,
 * which are kept so a missing index entry cannot cause its blob to be deleted).
 */
export function reachableDigests(index: InMemoryArtifactIndex): Set<string> {
  const reachable = new Set<string>();
  for (const record of index.list()) {
    reachable.add(record.ref.digest);
    for (const node of index.walkProvenance(record.ref.digest).nodes) reachable.add(node.digest);
  }
  return reachable;
}

export interface RetentionSweepOptions {
  store: PrunableBlobStore;
  index: InMemoryArtifactIndex;
  /** Spare objects younger than this (a grace period for in-flight writers). */
  olderThanMs?: number;
  now?: () => number;
}

/** Delete every blob the index can no longer reach, reporting what went. */
export async function sweepUnreferencedBlobs(options: RetentionSweepOptions): Promise<{ removed: string[]; freedBytes: number }> {
  return options.store.prune({
    keep: reachableDigests(options.index),
    ...(options.olderThanMs !== undefined ? { olderThanMs: options.olderThanMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
