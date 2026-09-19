import type { WorkspaceId } from "../core/ids.js";
import type { WorkspaceRevision } from "./source.js";
import type { WorkspaceSnapshot } from "./memory-workspace.js";

export interface SerializedWorkspaceSnapshot {
  id: WorkspaceId;
  revision?: WorkspaceRevision;
  overlay: Array<{ path: string; base64: string }>;
  deleted: string[];
  changed: string[];
}

export function serializeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): SerializedWorkspaceSnapshot {
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

export function deserializeWorkspaceSnapshot(snapshot: SerializedWorkspaceSnapshot): WorkspaceSnapshot {
  return {
    id: snapshot.id,
    revision: snapshot.revision,
    overlay: new Map(snapshot.overlay.map(({ path, base64 }) => [path, new Uint8Array(Buffer.from(base64, "base64"))])),
    deleted: new Set(snapshot.deleted),
    changed: new Set(snapshot.changed),
  };
}
