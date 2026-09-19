import { type WorkspaceId } from "../core/ids.js";
import type { Artifact } from "../core/types.js";
import { type TreeSource, type WorkspaceRevision } from "./source.js";
export interface WorkspaceChange {
    path: string;
    kind: "add" | "modify" | "delete";
    content?: Uint8Array;
}
export interface WorkspaceSnapshot {
    id: WorkspaceId;
    revision?: WorkspaceRevision;
    overlay: ReadonlyMap<string, Uint8Array>;
    deleted: ReadonlySet<string>;
    changed: ReadonlySet<string>;
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
    readText(path: string): Promise<string | undefined>;
    write(path: string, content: Uint8Array | string): void;
    delete(path: string): void;
    listDir(path?: string): Promise<string[]>;
    changedPaths(): string[];
    snapshot(): Promise<WorkspaceSnapshot>;
    restore(snapshot: WorkspaceSnapshot): void;
    fork(): MemoryWorkspace;
    diff(): Promise<WorkspaceChange[]>;
    exportArtifact(): Promise<Artifact>;
}
