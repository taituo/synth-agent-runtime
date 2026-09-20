import type { WorkspaceId } from "../core/ids.js";
import type { WorkspaceRevision } from "./source.js";
import type { WorkspaceSnapshot } from "./memory-workspace.js";
/**
 * Ceiling for the inline (base64) snapshot mechanism. Above this the snapshot
 * must travel out of band (git transport or the blob store); serializing a
 * larger overlay inline would bloat workflow history. The limit is on the raw
 * bytes, and it fails loudly rather than truncating silently.
 */
export declare const MAX_INLINE_SNAPSHOT_BYTES: number;
export interface SerializedWorkspaceSnapshot {
    id: WorkspaceId;
    revision?: WorkspaceRevision;
    overlay: Array<{
        path: string;
        base64: string;
    }>;
    links?: Array<{
        path: string;
        target: string;
    }>;
    deleted: string[];
    changed: string[];
}
export declare function serializeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): SerializedWorkspaceSnapshot;
export declare function deserializeWorkspaceSnapshot(snapshot: SerializedWorkspaceSnapshot): WorkspaceSnapshot;
