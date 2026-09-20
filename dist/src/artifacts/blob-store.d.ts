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
    /** Owning tenant, when written under a tenant-scoped principal. */
    tenantId?: string;
}
export interface PutBlobOptions {
    mediaType?: string;
    producedBy?: string;
    producedFrom?: readonly string[];
    /** Owning tenant; a tenant-scoped policy stamps this from the principal. */
    tenantId?: string;
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
    /** Every content object currently on disk, with its sidecar metadata. */
    list(): Promise<BlobRef[]>;
    /**
     * Lifecycle: delete content objects that are neither in `keep` nor younger
     * than `olderThanMs`. Reachability is the caller's job (the artifact index
     * knows what is still referenced); this only performs the deletion and
     * reports what it removed.
     */
    prune(options?: {
        keep?: Iterable<string>;
        olderThanMs?: number;
        now?: () => number;
    }): Promise<{
        removed: string[];
        freedBytes: number;
    }>;
}
export interface BlobPrincipal {
    tenantId: string;
    subject?: string;
}
export interface BlobAccessRequest {
    op: "read" | "write";
    digest: string;
    ref?: BlobRef;
    principal?: BlobPrincipal;
}
export interface BlobAccessPolicy {
    authorize(request: BlobAccessRequest): boolean;
}
/**
 * The default policy, and the decision for a single trust domain: possession of
 * the 256-bit digest is the capability, the digest is unguessable, and `get`
 * verifies integrity, so unrestricted read BY DIGEST is intentional. It is NOT
 * tenant isolation — use {@link TenantBlobPolicy} when principals span tenants.
 * See docs/BLOB-STORE.md.
 */
export declare class SharedTrustDomainPolicy implements BlobAccessPolicy {
    authorize(): boolean;
}
/**
 * Tenant isolation: a read is allowed when the blob is shared (no tenant) or
 * owned by the principal's tenant; a write requires a principal with a tenant.
 * Denies by default when there is no principal.
 */
export declare class TenantBlobPolicy implements BlobAccessPolicy {
    private readonly options;
    constructor(options?: {
        allowSharedRead?: boolean;
    });
    authorize(request: BlobAccessRequest): boolean;
}
/**
 * Write quota: a per-blob size ceiling and a per-tenant cumulative ceiling. It
 * is a small counter owned by the caller (a guard cannot know prior usage from
 * a content-addressed store without listing it), so a restart resets it; a
 * deployment that needs durable accounting persists `usage()`.
 */
export interface BlobWriteQuota {
    /** Throws `BLOB_QUOTA_EXCEEDED:blob:*` or `:tenant:*` when the write is too large. */
    check(tenantId: string | undefined, bytes: number): void;
    /** Record a committed write (call only when the object is new; dedup adds nothing). */
    commit(tenantId: string | undefined, bytes: number): void;
}
export interface TenantWriteQuotaOptions {
    /** Largest single object accepted. */
    maxBytesPerBlob?: number;
    /** Largest cumulative bytes accepted for one tenant (or the shared pool). */
    maxBytesPerTenant?: number;
}
export declare class TenantWriteQuota implements BlobWriteQuota {
    #private;
    private readonly options;
    constructor(options?: TenantWriteQuotaOptions);
    check(tenantId: string | undefined, bytes: number): void;
    commit(tenantId: string | undefined, bytes: number): void;
    usage(tenantId: string | undefined): number;
}
/** One access decision, emitted on read and write. */
export interface BlobAuditEvent {
    op: "read" | "write";
    digest: string;
    outcome: "allowed" | "denied" | "not-found";
    principal?: BlobPrincipal;
    at: number;
}
export type BlobAuditSink = (event: BlobAuditEvent) => void;
export interface GuardedBlobStoreOptions {
    quota?: BlobWriteQuota;
    audit?: BlobAuditSink;
    now?: () => number;
}
/**
 * A {@link BlobStore} view that consults a policy. Bind a principal with
 * `forPrincipal`; `stat` returns undefined rather than leaking the existence of
 * a blob the principal may not read. Optionally enforces a write quota and
 * emits an audit event for every read and write.
 */
export declare class GuardedBlobStore implements BlobStore {
    #private;
    private readonly inner;
    private readonly policy;
    private readonly principal?;
    private readonly options;
    constructor(inner: BlobStore, policy: BlobAccessPolicy, principal?: BlobPrincipal | undefined, options?: GuardedBlobStoreOptions);
    forPrincipal(principal: BlobPrincipal): GuardedBlobStore;
    put(bytes: Uint8Array, options?: PutBlobOptions): Promise<BlobRef>;
    get(digest: string): Promise<Uint8Array>;
    stat(digest: string): Promise<BlobRef | undefined>;
}
