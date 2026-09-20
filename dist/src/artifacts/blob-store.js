/**
 * Content-addressed blob store (artifact-egress mechanism 4).
 *
 * The out-of-band substrate for everything that is not a repo: build outputs,
 * logs, binaries. Content is stored by sha256 and addressed by digest; a
 * receipt carries the digest, never the bytes. Deliberately small — put, get,
 * stat — and local-filesystem-backed, not a service.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
export const SHA256_PREFIX = "sha256:";
export function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
export function digestOf(bytes) {
    return `${SHA256_PREFIX}${sha256Hex(bytes)}`;
}
function normalizeDigest(digest) {
    const hex = digest.startsWith(SHA256_PREFIX) ? digest.slice(SHA256_PREFIX.length) : digest;
    if (!/^[a-f0-9]{64}$/.test(hex))
        throw new Error(`Invalid blob digest: ${digest}`);
    return `${SHA256_PREFIX}${hex}`;
}
export class FileSystemBlobStore {
    root;
    constructor(root) {
        this.root = root;
    }
    #path(digest) {
        const hex = normalizeDigest(digest).slice(SHA256_PREFIX.length);
        return join(this.root, hex.slice(0, 2), hex);
    }
    #metaPath(digest) {
        return `${this.#path(digest)}.meta.json`;
    }
    async put(bytes, options = {}) {
        const digest = digestOf(bytes);
        const path = this.#path(digest);
        const mediaType = options.mediaType ?? "application/octet-stream";
        const meta = {
            mediaType,
            ...(options.producedBy ? { producedBy: options.producedBy } : {}),
            ...(options.producedFrom && options.producedFrom.length > 0 ? { producedFrom: [...options.producedFrom] } : {}),
            ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        };
        await mkdir(dirname(path), { recursive: true });
        // Deduplicate: identical content is one object.
        let existed = false;
        try {
            const existing = await readFile(path);
            if (digestOf(existing) === digest)
                existed = true;
        }
        catch {
            // not present yet
        }
        if (!existed) {
            // Atomic write so a crash cannot leave a half object under a real digest.
            const temp = `${path}.${randomUUID()}.tmp`;
            await writeFile(temp, bytes);
            await rename(temp, path);
        }
        // Sidecar metadata keeps `stat`'s mediaType/provenance stable without
        // polluting the content-addressed object itself (the object is the bytes).
        await writeFile(this.#metaPath(digest), JSON.stringify(meta)).catch(() => undefined);
        return { digest, size: bytes.byteLength, mechanism: "blob-store", ...meta };
    }
    async get(digest) {
        const normalized = normalizeDigest(digest);
        const bytes = new Uint8Array(await readFile(this.#path(normalized)));
        if (digestOf(bytes) !== normalized)
            throw new Error(`BLOB_CORRUPT:${normalized}`);
        return bytes;
    }
    async stat(digest) {
        const normalized = normalizeDigest(digest);
        try {
            const info = await stat(this.#path(normalized));
            let mediaType = "application/octet-stream";
            let producedBy;
            let producedFrom;
            let tenantId;
            try {
                const meta = JSON.parse(await readFile(this.#metaPath(normalized), "utf8"));
                if (typeof meta.mediaType === "string")
                    mediaType = meta.mediaType;
                if (typeof meta.producedBy === "string")
                    producedBy = meta.producedBy;
                if (typeof meta.tenantId === "string")
                    tenantId = meta.tenantId;
                if (Array.isArray(meta.producedFrom))
                    producedFrom = meta.producedFrom.filter((value) => typeof value === "string");
            }
            catch {
                // no sidecar: defaults
            }
            return {
                digest: normalized,
                size: info.size,
                mediaType,
                mechanism: "blob-store",
                ...(producedBy ? { producedBy } : {}),
                ...(producedFrom ? { producedFrom } : {}),
                ...(tenantId ? { tenantId } : {}),
            };
        }
        catch {
            return undefined;
        }
    }
    /** Every content object currently on disk, with its sidecar metadata. */
    async list() {
        const refs = [];
        const walk = async (dir) => {
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(path);
                }
                else if (/^[a-f0-9]{64}$/.test(entry.name)) {
                    const ref = await this.stat(`${SHA256_PREFIX}${entry.name}`);
                    if (ref)
                        refs.push(ref);
                }
            }
        };
        await walk(this.root);
        return refs;
    }
    /**
     * Lifecycle: delete content objects that are neither in `keep` nor younger
     * than `olderThanMs`. Reachability is the caller's job (the artifact index
     * knows what is still referenced); this only performs the deletion and
     * reports what it removed.
     */
    async prune(options = {}) {
        const keep = new Set([...(options.keep ?? [])].map((digest) => normalizeDigest(digest)));
        const now = (options.now ?? Date.now)();
        const removed = [];
        let freedBytes = 0;
        for (const ref of await this.list()) {
            if (keep.has(ref.digest))
                continue;
            if (options.olderThanMs !== undefined) {
                const info = await stat(this.#path(ref.digest)).catch(() => undefined);
                if (info && now - info.mtimeMs < options.olderThanMs)
                    continue;
            }
            freedBytes += ref.size;
            await rm(this.#path(ref.digest), { force: true });
            await rm(this.#metaPath(ref.digest), { force: true });
            removed.push(ref.digest);
        }
        return { removed, freedBytes };
    }
}
/**
 * The default policy, and the decision for a single trust domain: possession of
 * the 256-bit digest is the capability, the digest is unguessable, and `get`
 * verifies integrity, so unrestricted read BY DIGEST is intentional. It is NOT
 * tenant isolation — use {@link TenantBlobPolicy} when principals span tenants.
 * See docs/BLOB-STORE.md.
 */
export class SharedTrustDomainPolicy {
    authorize() {
        return true;
    }
}
/**
 * Tenant isolation: a read is allowed when the blob is shared (no tenant) or
 * owned by the principal's tenant; a write requires a principal with a tenant.
 * Denies by default when there is no principal.
 */
export class TenantBlobPolicy {
    options;
    constructor(options = {}) {
        this.options = options;
    }
    authorize(request) {
        if (request.op === "write")
            return request.principal !== undefined;
        const tenant = request.principal?.tenantId;
        if (!tenant)
            return false;
        const owner = request.ref?.tenantId;
        if (owner === undefined)
            return this.options.allowSharedRead !== false;
        return owner === tenant;
    }
}
export class TenantWriteQuota {
    options;
    #used = new Map();
    constructor(options = {}) {
        this.options = options;
    }
    #key(tenantId) {
        return tenantId ?? "<shared>";
    }
    check(tenantId, bytes) {
        const { maxBytesPerBlob, maxBytesPerTenant } = this.options;
        if (maxBytesPerBlob !== undefined && bytes > maxBytesPerBlob) {
            throw new Error(`BLOB_QUOTA_EXCEEDED:blob:${bytes}>${maxBytesPerBlob}`);
        }
        if (maxBytesPerTenant !== undefined) {
            const used = this.#used.get(this.#key(tenantId)) ?? 0;
            if (used + bytes > maxBytesPerTenant)
                throw new Error(`BLOB_QUOTA_EXCEEDED:tenant:${used + bytes}>${maxBytesPerTenant}`);
        }
    }
    commit(tenantId, bytes) {
        const key = this.#key(tenantId);
        this.#used.set(key, (this.#used.get(key) ?? 0) + bytes);
    }
    usage(tenantId) {
        return this.#used.get(this.#key(tenantId)) ?? 0;
    }
}
/**
 * A {@link BlobStore} view that consults a policy. Bind a principal with
 * `forPrincipal`; `stat` returns undefined rather than leaking the existence of
 * a blob the principal may not read. Optionally enforces a write quota and
 * emits an audit event for every read and write.
 */
export class GuardedBlobStore {
    inner;
    policy;
    principal;
    options;
    constructor(inner, policy, principal, options = {}) {
        this.inner = inner;
        this.policy = policy;
        this.principal = principal;
        this.options = options;
    }
    #emit(event) {
        this.options.audit?.({ ...event, ...(this.principal ? { principal: this.principal } : {}), at: (this.options.now ?? Date.now)() });
    }
    forPrincipal(principal) {
        return new GuardedBlobStore(this.inner, this.policy, principal, this.options);
    }
    async put(bytes, options = {}) {
        const digest = digestOf(bytes);
        if (!this.policy.authorize({ op: "write", digest, principal: this.principal })) {
            this.#emit({ op: "write", digest, outcome: "denied" });
            throw new Error(`BLOB_FORBIDDEN:write:${digest}`);
        }
        // Dedup adds no bytes: charge only when the object is new.
        const existing = await this.inner.stat(digest).catch(() => undefined);
        if (!existing) {
            this.options.quota?.check(this.principal?.tenantId, bytes.byteLength);
        }
        const ref = await this.inner.put(bytes, { ...options, ...(this.principal?.tenantId ? { tenantId: this.principal.tenantId } : {}) });
        if (!existing)
            this.options.quota?.commit(this.principal?.tenantId, bytes.byteLength);
        this.#emit({ op: "write", digest: ref.digest, outcome: "allowed" });
        return ref;
    }
    async get(digest) {
        const ref = await this.inner.stat(digest);
        if (!ref) {
            this.#emit({ op: "read", digest, outcome: "not-found" });
            throw new Error(`BLOB_NOT_FOUND:${digest}`);
        }
        if (!this.policy.authorize({ op: "read", digest: ref.digest, ref, principal: this.principal })) {
            this.#emit({ op: "read", digest: ref.digest, outcome: "denied" });
            throw new Error(`BLOB_FORBIDDEN:read:${digest}`);
        }
        this.#emit({ op: "read", digest: ref.digest, outcome: "allowed" });
        return this.inner.get(ref.digest);
    }
    async stat(digest) {
        const ref = await this.inner.stat(digest);
        if (!ref)
            return undefined;
        if (!this.policy.authorize({ op: "read", digest: ref.digest, ref, principal: this.principal }))
            return undefined;
        return ref;
    }
}
