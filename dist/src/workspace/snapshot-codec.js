/**
 * Ceiling for the inline (base64) snapshot mechanism. Above this the snapshot
 * must travel out of band (git transport or the blob store); serializing a
 * larger overlay inline would bloat workflow history. The limit is on the raw
 * bytes, and it fails loudly rather than truncating silently.
 */
export const MAX_INLINE_SNAPSHOT_BYTES = 256 * 1024;
export function serializeWorkspaceSnapshot(snapshot) {
    let total = 0;
    for (const bytes of snapshot.overlay.values())
        total += bytes.byteLength;
    if (total > MAX_INLINE_SNAPSHOT_BYTES) {
        throw new Error(`INLINE_SNAPSHOT_TOO_LARGE:${total}>${MAX_INLINE_SNAPSHOT_BYTES}; use the git transport or the blob store instead`);
    }
    return {
        id: snapshot.id,
        revision: snapshot.revision,
        overlay: [...snapshot.overlay.entries()].map(([path, bytes]) => ({
            path,
            base64: Buffer.from(bytes).toString("base64"),
        })),
        ...(snapshot.links && snapshot.links.size > 0 ? { links: [...snapshot.links.entries()].map(([path, target]) => ({ path, target })) } : {}),
        deleted: [...snapshot.deleted],
        changed: [...snapshot.changed],
    };
}
export function deserializeWorkspaceSnapshot(snapshot) {
    return {
        id: snapshot.id,
        revision: snapshot.revision,
        overlay: new Map(snapshot.overlay.map(({ path, base64 }) => [path, new Uint8Array(Buffer.from(base64, "base64"))])),
        links: new Map((snapshot.links ?? []).map(({ path, target }) => [path, target])),
        deleted: new Set(snapshot.deleted),
        changed: new Set(snapshot.changed),
    };
}
