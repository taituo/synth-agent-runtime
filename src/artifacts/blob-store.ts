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

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestOf(bytes: Uint8Array): string {
  return `${SHA256_PREFIX}${sha256Hex(bytes)}`;
}

function normalizeDigest(digest: string): string {
  const hex = digest.startsWith(SHA256_PREFIX) ? digest.slice(SHA256_PREFIX.length) : digest;
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error(`Invalid blob digest: ${digest}`);
  return `${SHA256_PREFIX}${hex}`;
}

export class FileSystemBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  #path(digest: string): string {
    const hex = normalizeDigest(digest).slice(SHA256_PREFIX.length);
    return join(this.root, hex.slice(0, 2), hex);
  }

  #metaPath(digest: string): string {
    return `${this.#path(digest)}.meta.json`;
  }

  async put(bytes: Uint8Array, options: PutBlobOptions = {}): Promise<BlobRef> {
    const digest = digestOf(bytes);
    const path = this.#path(digest);
    const mediaType = options.mediaType ?? "application/octet-stream";
    const meta = {
      mediaType,
      ...(options.producedBy ? { producedBy: options.producedBy } : {}),
      ...(options.producedFrom && options.producedFrom.length > 0 ? { producedFrom: [...options.producedFrom] } : {}),
    };
    await mkdir(dirname(path), { recursive: true });
    // Deduplicate: identical content is one object.
    let existed = false;
    try {
      const existing = await readFile(path);
      if (digestOf(existing) === digest) existed = true;
    } catch {
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

  async get(digest: string): Promise<Uint8Array> {
    const normalized = normalizeDigest(digest);
    const bytes = new Uint8Array(await readFile(this.#path(normalized)));
    if (digestOf(bytes) !== normalized) throw new Error(`BLOB_CORRUPT:${normalized}`);
    return bytes;
  }

  async stat(digest: string): Promise<BlobRef | undefined> {
    const normalized = normalizeDigest(digest);
    try {
      const info = await stat(this.#path(normalized));
      let mediaType = "application/octet-stream";
      let producedBy: string | undefined;
      let producedFrom: string[] | undefined;
      try {
        const meta = JSON.parse(await readFile(this.#metaPath(normalized), "utf8")) as {
          mediaType?: unknown;
          producedBy?: unknown;
          producedFrom?: unknown;
        };
        if (typeof meta.mediaType === "string") mediaType = meta.mediaType;
        if (typeof meta.producedBy === "string") producedBy = meta.producedBy;
        if (Array.isArray(meta.producedFrom)) producedFrom = meta.producedFrom.filter((value): value is string => typeof value === "string");
      } catch {
        // no sidecar: defaults
      }
      return {
        digest: normalized,
        size: info.size,
        mediaType,
        mechanism: "blob-store",
        ...(producedBy ? { producedBy } : {}),
        ...(producedFrom ? { producedFrom } : {}),
      };
    } catch {
      return undefined;
    }
  }
}
