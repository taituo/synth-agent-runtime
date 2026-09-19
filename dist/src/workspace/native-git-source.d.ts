import type { SourceInfo, TreeSource, WorkspaceRevision } from "./source.js";
export interface NativeGitSourceOptions {
    gitDir: string;
    remote: string;
    ref?: string;
    depth?: number;
    filter?: string;
    sparse?: readonly string[];
    gitBin?: string;
    /** Refuse hydration of an individual blob larger than this. Default: 32 MiB. */
    maxBlobBytes?: number;
}
/**
 * Checkout-less native Git source.
 *
 * The backing repository is a bare partial clone. Agent mutations never touch it;
 * the MemoryWorkspace overlay remains RAM-only. `blob:none` lets Git lazily fetch
 * blobs from the promisor remote when a file is first read.
 */
export declare class NativeGitSource implements TreeSource {
    #private;
    readonly name: string;
    private constructor();
    static open(options: NativeGitSourceOptions): Promise<NativeGitSource>;
    revision(): Promise<WorkspaceRevision>;
    stat(path: string): Promise<SourceInfo | undefined>;
    listDir(path: string): Promise<readonly SourceInfo[]>;
    readFile(path: string): Promise<Uint8Array>;
    listFiles(): AsyncIterable<string>;
    close(): Promise<void>;
}
