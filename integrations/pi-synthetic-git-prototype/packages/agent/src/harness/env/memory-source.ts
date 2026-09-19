/**
 * Read-only source tree mounted under /workspace by MemoryExecutionEnv.
 *
 * A source may be backed by a Git commit, object store, database, tarball, or
 * another in-memory world. Source methods use slash-separated paths relative
 * to the source root ("" is the root directory).
 */

export type VirtualSourceKind = "file" | "directory" | "symlink";

export interface VirtualSourceInfo {
	path: string;
	kind: VirtualSourceKind;
	size: number;
	mtimeMs: number;
	/** Optional immutable object identity, e.g. a Git blob SHA. */
	objectId?: string;
}

export interface WorkspaceRevision {
	kind: "git" | "snapshot" | "unknown";
	remote?: string;
	ref?: string;
	commit?: string;
}

export interface VirtualTreeSource {
	/** Human-readable source name for diagnostics. */
	readonly name: string;

	/** Resolve immutable source revision metadata when available. */
	revision(): Promise<WorkspaceRevision | undefined>;

	/** Metadata for one relative path; undefined means it does not exist. */
	stat(path: string): Promise<VirtualSourceInfo | undefined>;

	/** Direct children of a directory. */
	listDir(path: string): Promise<readonly VirtualSourceInfo[]>;

	/** Read an immutable file from the source. */
	readFile(path: string): Promise<Uint8Array>;

	/**
	 * Enumerate source files when supported. Implementations may perform lazy
	 * network traversal. This is primarily used by synthetic `git ls-files`.
	 */
	listFiles?(): AsyncIterable<string>;
}

export interface StaticTreeFile {
	path: string;
	content: string | Uint8Array;
	mtimeMs?: number;
}

interface StaticEntry {
	kind: "file" | "directory";
	bytes?: Uint8Array;
	mtimeMs: number;
}

const encoder = new TextEncoder();

function normalizeRelativePath(path: string): string {
	const parts: string[] = [];
	for (const raw of path.replace(/\\/g, "/").split("/")) {
		if (!raw || raw === ".") continue;
		if (raw === "..") {
			parts.pop();
			continue;
		}
		parts.push(raw);
	}
	return parts.join("/");
}

function basename(path: string): string {
	const normalized = normalizeRelativePath(path);
	const index = normalized.lastIndexOf("/");
	return index === -1 ? normalized : normalized.slice(index + 1);
}

function parent(path: string): string {
	const normalized = normalizeRelativePath(path);
	const index = normalized.lastIndexOf("/");
	return index === -1 ? "" : normalized.slice(0, index);
}

/** Small immutable source useful for tests and programmatic seeding. */
export class StaticTreeSource implements VirtualTreeSource {
	readonly name: string;
	readonly #entries = new Map<string, StaticEntry>();
	readonly #revision: WorkspaceRevision | undefined;

	constructor(options: {
		name?: string;
		files: readonly StaticTreeFile[];
		revision?: WorkspaceRevision;
	}) {
		this.name = options.name ?? "static";
		this.#revision = options.revision;
		this.#entries.set("", { kind: "directory", mtimeMs: 0 });
		for (const file of options.files) {
			const path = normalizeRelativePath(file.path);
			if (!path) throw new Error("StaticTreeSource file path must not be empty");
			let cursor = parent(path);
			while (true) {
				if (!this.#entries.has(cursor)) this.#entries.set(cursor, { kind: "directory", mtimeMs: 0 });
				if (!cursor) break;
				cursor = parent(cursor);
			}
			const bytes = typeof file.content === "string" ? encoder.encode(file.content) : file.content.slice();
			this.#entries.set(path, { kind: "file", bytes, mtimeMs: file.mtimeMs ?? 0 });
		}
	}

	async revision(): Promise<WorkspaceRevision | undefined> {
		return this.#revision ? { ...this.#revision } : undefined;
	}

	async stat(path: string): Promise<VirtualSourceInfo | undefined> {
		const normalized = normalizeRelativePath(path);
		const entry = this.#entries.get(normalized);
		if (!entry) return undefined;
		return {
			path: normalized,
			kind: entry.kind,
			size: entry.kind === "file" ? (entry.bytes?.byteLength ?? 0) : 0,
			mtimeMs: entry.mtimeMs,
		};
	}

	async listDir(path: string): Promise<readonly VirtualSourceInfo[]> {
		const normalized = normalizeRelativePath(path);
		const directory = this.#entries.get(normalized);
		if (!directory || directory.kind !== "directory") return [];
		const children: VirtualSourceInfo[] = [];
		for (const [candidate, entry] of this.#entries) {
			if (candidate === normalized || parent(candidate) !== normalized) continue;
			children.push({
				path: candidate,
				kind: entry.kind,
				size: entry.kind === "file" ? (entry.bytes?.byteLength ?? 0) : 0,
				mtimeMs: entry.mtimeMs,
			});
		}
		children.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
		return children;
	}

	async readFile(path: string): Promise<Uint8Array> {
		const normalized = normalizeRelativePath(path);
		const entry = this.#entries.get(normalized);
		if (!entry || entry.kind !== "file" || !entry.bytes) throw new Error(`Source file not found: ${normalized}`);
		return entry.bytes.slice();
	}

	async *listFiles(): AsyncIterable<string> {
		for (const [path, entry] of [...this.#entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			if (entry.kind === "file") yield path;
		}
	}
}
