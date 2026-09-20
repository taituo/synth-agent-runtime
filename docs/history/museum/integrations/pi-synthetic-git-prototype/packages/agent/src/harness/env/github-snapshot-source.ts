import type { VirtualSourceInfo, VirtualTreeSource, WorkspaceRevision } from "./memory-source.ts";

interface GitHubContentEntry {
	type: "file" | "dir" | "symlink" | "submodule";
	path: string;
	size?: number;
	sha?: string;
}

interface CachedMeta extends VirtualSourceInfo {
	sha?: string;
}

const encoder = new TextEncoder();

function normalizeRelative(path: string): string {
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

function encodePath(path: string): string {
	return normalizeRelative(path)
		.split("/")
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/");
}

function base64ToBytes(value: string): Uint8Array {
	const compact = value.replace(/\s+/g, "");
	if (typeof atob === "function") {
		const binary = atob(compact);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	}
	throw new Error("No base64 decoder is available in this runtime");
}

/**
 * Lazy, read-only GitHub commit snapshot.
 *
 * It never creates a local checkout or .git directory. The commit is resolved
 * once, directory metadata is hydrated on demand via the Contents API, and
 * blobs are fetched only when a file is actually read. This behaves like a
 * shallow, sparse, demand-paged clone for the synthetic workspace.
 */
export class GitHubSnapshotSource implements VirtualTreeSource {
	readonly name: string;
	readonly #owner: string;
	readonly #repo: string;
	readonly #ref: string;
	readonly #token?: string;
	readonly #apiBase: string;
	readonly #sparsePrefixes: readonly string[];
	readonly #meta = new Map<string, CachedMeta>();
	readonly #children = new Map<string, readonly CachedMeta[]>();
	readonly #blobs = new Map<string, Uint8Array>();
	#commit?: string;

	constructor(options: {
		owner: string;
		repo: string;
		ref?: string;
		token?: string;
		apiBase?: string;
		/** Relative path prefixes to expose. Ancestors are exposed automatically. */
		sparse?: readonly string[];
	}) {
		this.#owner = options.owner;
		this.#repo = options.repo;
		this.#ref = options.ref ?? "HEAD";
		this.#token = options.token;
		this.#apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
		this.#sparsePrefixes = (options.sparse ?? []).map(normalizeRelative).filter(Boolean);
		this.name = `github:${this.#owner}/${this.#repo}@${this.#ref}`;
		this.#meta.set("", { path: "", kind: "directory", size: 0, mtimeMs: 0 });
	}

	async revision(): Promise<WorkspaceRevision> {
		await this.#ensureCommit();
		return {
			kind: "git",
			remote: `https://github.com/${this.#owner}/${this.#repo}.git`,
			ref: this.#ref,
			commit: this.#commit,
		};
	}

	async stat(path: string): Promise<VirtualSourceInfo | undefined> {
		const relative = normalizeRelative(path);
		if (!this.#isRelevant(relative)) return undefined;
		const cached = this.#meta.get(relative);
		if (cached) return { ...cached };
		if (!relative) return { path: "", kind: "directory", size: 0, mtimeMs: 0 };
		const payload = await this.#fetchContents(relative);
		if (Array.isArray(payload)) {
			const info: CachedMeta = { path: relative, kind: "directory", size: 0, mtimeMs: 0 };
			this.#meta.set(relative, info);
			this.#cacheDirectory(relative, payload);
			return { ...info };
		}
		const info = this.#toMeta(payload);
		if (!this.#isRelevant(info.path)) return undefined;
		this.#meta.set(relative, info);
		return { ...info };
	}

	async listDir(path: string): Promise<readonly VirtualSourceInfo[]> {
		const relative = normalizeRelative(path);
		if (!this.#isRelevant(relative)) return [];
		const cached = this.#children.get(relative);
		if (cached) return cached.map((entry) => ({ ...entry }));
		const payload = await this.#fetchContents(relative);
		if (!Array.isArray(payload)) return [];
		const entries = this.#cacheDirectory(relative, payload);
		return entries.map((entry) => ({ ...entry }));
	}

	async readFile(path: string): Promise<Uint8Array> {
		const relative = normalizeRelative(path);
		if (!this.#isRelevant(relative)) throw new Error(`Path is outside sparse view: ${relative}`);
		const info = (await this.stat(relative)) as CachedMeta | undefined;
		if (!info || info.kind !== "file") throw new Error(`GitHub source file not found: ${relative}`);
		const sha = this.#meta.get(relative)?.sha;
		if (!sha) throw new Error(`GitHub source has no blob SHA for ${relative}`);
		const cached = this.#blobs.get(sha);
		if (cached) return cached.slice();

		const response = await this.#request(`/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/git/blobs/${encodeURIComponent(sha)}`);
		const payload = (await response.json()) as { content?: string; encoding?: string };
		if (payload.encoding !== "base64" || typeof payload.content !== "string") {
			throw new Error(`Unsupported GitHub blob encoding for ${relative}`);
		}
		const bytes = base64ToBytes(payload.content);
		this.#blobs.set(sha, bytes);
		return bytes.slice();
	}

	async *listFiles(): AsyncIterable<string> {
		const stack = [""];
		while (stack.length > 0) {
			const dir = stack.pop()!;
			const children = await this.listDir(dir);
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index]!;
				if (child.kind === "directory") stack.push(child.path);
				else if (child.kind === "file") yield child.path;
			}
		}
	}

	async #ensureCommit(): Promise<void> {
		if (this.#commit) return;
		const response = await this.#request(
			`/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/commits/${encodeURIComponent(this.#ref)}`,
		);
		const payload = (await response.json()) as { sha?: string };
		if (!payload.sha) throw new Error(`Unable to resolve GitHub ref ${this.#ref}`);
		this.#commit = payload.sha;
	}

	async #fetchContents(path: string): Promise<GitHubContentEntry | GitHubContentEntry[]> {
		await this.#ensureCommit();
		const suffix = path ? `/${encodePath(path)}` : "";
		const response = await this.#request(
			`/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/contents${suffix}?ref=${encodeURIComponent(this.#commit!)}`,
		);
		return (await response.json()) as GitHubContentEntry | GitHubContentEntry[];
	}

	#cacheDirectory(path: string, entries: readonly GitHubContentEntry[]): readonly CachedMeta[] {
		const mapped = entries
			.map((entry) => this.#toMeta(entry))
			.filter((entry) => this.#isRelevant(entry.path))
			.sort((a, b) => a.path.localeCompare(b.path));
		this.#children.set(path, mapped);
		for (const entry of mapped) this.#meta.set(entry.path, entry);
		return mapped;
	}

	#toMeta(entry: GitHubContentEntry): CachedMeta {
		const kind = entry.type === "dir" ? "directory" : entry.type === "symlink" ? "symlink" : "file";
		return {
			path: normalizeRelative(entry.path),
			kind,
			size: entry.size ?? 0,
			mtimeMs: 0,
			objectId: entry.sha,
			sha: entry.sha,
		};
	}

	#isRelevant(path: string): boolean {
		if (this.#sparsePrefixes.length === 0 || path === "") return true;
		return this.#sparsePrefixes.some(
			(prefix) => path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`),
		);
	}

	async #request(path: string): Promise<Response> {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
		const response = await fetch(`${this.#apiBase}${path}`, { headers });
		if (!response.ok) {
			let detail = `${response.status} ${response.statusText}`;
			try {
				const body = await response.text();
				if (body) detail += `: ${body.slice(0, 512)}`;
			} catch {}
			throw new Error(`GitHub source request failed: ${detail}`);
		}
		return response;
	}
}

/** Tiny helper for sources synthesized from generated text. */
export function textBlob(text: string): Uint8Array {
	return encoder.encode(text);
}
