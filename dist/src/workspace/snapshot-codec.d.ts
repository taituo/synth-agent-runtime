import type { WorkspaceId } from "../core/ids.js";
import type { WorkspaceRevision } from "./source.js";
import type { WorkspaceSnapshot } from "./memory-workspace.js";
export interface SerializedWorkspaceSnapshot {
    id: WorkspaceId;
    revision?: WorkspaceRevision;
    overlay: Array<{
        path: string;
        base64: string;
    }>;
    deleted: string[];
    changed: string[];
}
export declare function serializeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): SerializedWorkspaceSnapshot;
export declare function deserializeWorkspaceSnapshot(snapshot: SerializedWorkspaceSnapshot): WorkspaceSnapshot;
