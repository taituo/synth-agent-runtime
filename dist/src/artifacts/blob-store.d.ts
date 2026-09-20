export declare const SHA256_PREFIX = "sha256:";
export interface BlobRef {
    digest: string;
    size: number;
    mediaType: string;
    mechanism: "blob-store";
    /** Who produced it (e.g. an agent/workflow id), for provenance. */
    producedBy?: string;
    /** Digests of the inputs it was derived from, so a chain is walkable. */
    producedFrom?: string[];
}
export interface PutBlobOptions {
    mediaType?: string;
    producedBy?: string;
    producedFrom?: readonly string[];
}
export interface BlobStore {
    put(bytes: Uint8Array, options?: PutBlobOptions): Promise<BlobRef>;
    /** Read exactly the bytes for `digest`, verifying integrity. */
    get(digest: string): Promise<Uint8Array>;
    stat(digest: string): Promise<BlobRef | undefined>;
}
export declare function sha256Hex(bytes: Uint8Array): string;
export declare function digestOf(bytes: Uint8Array): string;
export declare class FileSystemBlobStore implements BlobStore {
    #private;
    private readonly root;
    constructor(root: string);
    put(bytes: Uint8Array, options?: PutBlobOptions): Promise<BlobRef>;
    get(digest: string): Promise<Uint8Array>;
    stat(digest: string): Promise<BlobRef | undefined>;
}
