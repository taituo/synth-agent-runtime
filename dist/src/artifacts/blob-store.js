/**
 * Content-addressed blob store (artifact-egress mechanism 4).
 *
 * The out-of-band substrate for everything that is not a repo: build outputs,
 * logs, binaries. Content is stored by sha256 and addressed by digest; a
 * receipt carries the digest, never the bytes. Deliberately small — put, get,
 * stat — and local-filesystem-backed, not a service.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
    async put(bytes, options = {}) {
        const digest = digestOf(bytes);
        const path = this.#path(digest);
        const mediaType = options.mediaType ?? "application/octet-stream";
        await mkdir(dirname(path), { recursive: true });
        // Deduplicate: identical content is one object.
        try {
            const existing = await readFile(path);
            if (digestOf(existing) === digest)
                return { digest, size: existing.byteLength, mediaType, mechanism: "blob-store" };
        }
        catch {
            // not present yet
        }
        // Atomic write so a crash cannot leave a half object under a real digest.
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, bytes);
        await rename(temp, path);
        return { digest, size: bytes.byteLength, mediaType, mechanism: "blob-store" };
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
            return { digest: normalized, size: info.size, mediaType: "application/octet-stream", mechanism: "blob-store" };
        }
        catch {
            return undefined;
        }
    }
}
