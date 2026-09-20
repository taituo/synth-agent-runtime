/**
 * Every digest the index can still reach: each recorded artifact, plus every
 * ancestor named by `producedFrom` (including referenced-but-unrecorded digests,
 * which are kept so a missing index entry cannot cause its blob to be deleted).
 */
export function reachableDigests(index) {
    const reachable = new Set();
    for (const record of index.list()) {
        reachable.add(record.ref.digest);
        for (const node of index.walkProvenance(record.ref.digest).nodes)
            reachable.add(node.digest);
    }
    return reachable;
}
/** Delete every blob the index can no longer reach, reporting what went. */
export async function sweepUnreferencedBlobs(options) {
    return options.store.prune({
        keep: reachableDigests(options.index),
        ...(options.olderThanMs !== undefined ? { olderThanMs: options.olderThanMs } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
}
