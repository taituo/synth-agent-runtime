export function serializeWorkspaceSnapshot(snapshot) {
    return {
        id: snapshot.id,
        revision: snapshot.revision,
        overlay: [...snapshot.overlay.entries()].map(([path, bytes]) => ({
            path,
            base64: Buffer.from(bytes).toString("base64"),
        })),
        deleted: [...snapshot.deleted],
        changed: [...snapshot.changed],
    };
}
export function deserializeWorkspaceSnapshot(snapshot) {
    return {
        id: snapshot.id,
        revision: snapshot.revision,
        overlay: new Map(snapshot.overlay.map(({ path, base64 }) => [path, new Uint8Array(Buffer.from(base64, "base64"))])),
        deleted: new Set(snapshot.deleted),
        changed: new Set(snapshot.changed),
    };
}
