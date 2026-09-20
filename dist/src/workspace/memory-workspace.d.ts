import { type WorkspaceId } from "../core/ids.js";
import type { Artifact } from "../core/types.js";
import type { BlobStore } from "../artifacts/blob-store.js";
import { type TreeSource, type WorkspaceRevision } from "./source.js";
export interface WorkspaceChange {
    path: string;
    kind: "add" | "modify" | "delete";
    content?: Uint8Array;
}
/** The wire form of a workspace diff: file bytes are base64, never raw JSON. */
export interface EncodedWorkspaceDiff {
    revision?: WorkspaceRevision;
    changes: Array<{
        path: string;
        kind: WorkspaceChange["kind"];
        contentBase64?: string;
    }>;
}
export declare const WORKSPACE_DIFF_MEDIA_TYPE = "application/vnd.synth.workspace-diff+json";
export declare function encodeWorkspaceDiff(diff: {
    revision?: WorkspaceRevision;
    changes: readonly WorkspaceChange[];
}): Uint8Array;
export declare function decodeWorkspaceDiff(bytes: Uint8Array): {
    revision?: WorkspaceRevision;
    changes: WorkspaceChange[];
};
export interface WorkspaceSnapshot {
    id: WorkspaceId;
    revision?: WorkspaceRevision;
    overlay: ReadonlyMap<string, Uint8Array>;
    links?: ReadonlyMap<string, string>;
    deleted: ReadonlySet<string>;
    changed: ReadonlySet<string>;
}
export interface ExportArtifactOptions {
    /** Include a bounded inline copy when the content is within the ceiling. */
    inline?: boolean;
}
export declare class MemoryWorkspace {
    #private;
    readonly id: WorkspaceId;
    readonly source?: TreeSource;
    constructor(options?: {
        id?: WorkspaceId;
        source?: TreeSource;
    });
    read(path: string): Promise<Uint8Array | undefined>;
    /**
     * Kind of an existing path, or undefined. A directory exists if it is in the
     * source tree or if anything is overlaid beneath it; deleting a directory
     * makes its whole subtree absent (see `#isDeleted`).
     */
    stat(path: string): Promise<{
        kind: "file" | "directory" | "symlink";
    } | undefined>;
    readText(path: string): Promise<string | undefined>;
    write(path: string, content: Uint8Array | string): void;
    /**
     * Create a symlink, validating that its target resolves INSIDE the workspace.
     * This is the caller that puts the symlink-containment policy in force: an
     * escaping target (absolute, climbing out, or via an intermediate symlinked
     * directory) is rejected with the shared WORKSPACE_PATH_ESCAPES error, the
     * same as a traversing write. A dangling target is a valid link and is kept.
     */
    symlink(path: string, target: string): void;
    delete(path: string): void;
    listDir(path?: string): Promise<string[]>;
    changedPaths(): string[];
    snapshot(): Promise<WorkspaceSnapshot>;
    restore(snapshot: WorkspaceSnapshot): void;
    fork(): MemoryWorkspace;
    diff(): Promise<WorkspaceChange[]>;
    /**
     * Export the workspace diff as an Artifact whose `ref` points at the content
     * in `store`. The bytes never travel on the Artifact (the blackboard rule),
     * and `decodeWorkspaceDiff(await store.get(ref.digest))` recovers them.
     *
     * `options.inline` adds the bounded escape hatch: a copy on the Artifact when
     * the content is within `MAX_INLINE_SNAPSHOT_BYTES`, and an explicit
     * `INLINE_ARTIFACT_TOO_LARGE` when it is not.
     */
    exportArtifact(store: BlobStore, options?: ExportArtifactOptions): Promise<Artifact>;
}
