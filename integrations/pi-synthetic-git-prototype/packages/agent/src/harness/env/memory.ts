import type { Context } from "../context.ts";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLine,
	type TextLineReader,
} from "../types.ts";
import { OutputCapture } from "../utils/output-capture.ts";
import { MemoryGit } from "./memory-git.ts";
import type { VirtualSourceInfo, VirtualTreeSource, WorkspaceRevision } from "./memory-source.ts";

export { GitHubSnapshotSource } from "./github-snapshot-source.ts";
export {
	StaticTreeSource,
	type StaticTreeFile,
	type VirtualSourceInfo,
	type VirtualTreeSource,
	type WorkspaceRevision,
} from "./memory-source.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

interface MemoryFile {
	kind: "file";
	bytes: Uint8Array;
	mtimeMs: number;
}

interface MemoryDirectory {
	kind: "directory";
	mtimeMs: number;
}

type MemoryEntry = MemoryFile | MemoryDirectory;

export interface MemoryWorkspaceChange {
	path: string;
	kind: "add" | "modify" | "delete";
	content?: Uint8Array;
}

export interface MemoryWorkspaceArtifact {
	revision?: WorkspaceRevision;
	changes: MemoryWorkspaceChange[];
}

export interface MemoryExecutionEnvOptions {
	cwd?: string;
	source?: VirtualTreeSource;
	env?: Record<string, string>;
	/** Deterministic synthetic clock. Defaults to an incrementing logical clock. */
	now?: () => number;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface ShellState {
	cwd: string;
	env: Record<string, string>;
}

function virtualBasename(path: string): string {
	const normalized = normalizeAbsolute(path);
	if (normalized === "/") return "/";
	const index = normalized.lastIndexOf("/");
	return normalized.slice(index + 1);
}

function virtualParent(path: string): string {
	const normalized = normalizeAbsolute(path);
	if (normalized === "/") return "/";
	const index = normalized.lastIndexOf("/");
	return index <= 0 ? "/" : normalized.slice(0, index);
}

function normalizeAbsolute(path: string): string {
	const normalizedInput = path.replace(/\\/g, "/");
	const parts: string[] = [];
	for (const raw of normalizedInput.split("/")) {
		if (!raw || raw === ".") continue;
		if (raw === "..") {
			parts.pop();
			continue;
		}
		parts.push(raw);
	}
	return `/${parts.join("/")}`;
}

function resolveVirtual(cwd: string, path: string): string {
	if (path.startsWith("/")) return normalizeAbsolute(path);
	return normalizeAbsolute(`${cwd}/${path}`);
}

function joinVirtual(parts: readonly string[]): string {
	let result = "";
	for (const part of parts) {
		if (!part) continue;
		if (part.startsWith("/")) result = part;
		else result = result ? `${result}/${part}` : part;
	}
	return normalizeAbsolute(result.startsWith("/") ? result : `/${result}`);
}

function sourceRelative(path: string): string | undefined {
	const normalized = normalizeAbsolute(path);
	if (normalized === "/workspace") return "";
	if (!normalized.startsWith("/workspace/")) return undefined;
	return normalized.slice("/workspace/".length);
}

function pathInsideSyntheticRoots(path: string): boolean {
	return path === "/" || path === "/workspace" || path.startsWith("/workspace/") || path === "/tmp" || path.startsWith("/tmp/");
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

function wildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

function compareBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

class MemoryTextLineReader implements TextLineReader {
	readonly #lines: TextLine[];
	#index = 0;
	#closed = false;

	constructor(text: string) {
		this.#lines = [];
		let cursor = 0;
		while (cursor < text.length) {
			const newline = text.indexOf("\n", cursor);
			if (newline === -1) {
				this.#lines.push({ text: text.slice(cursor), terminated: false });
				cursor = text.length;
			} else {
				this.#lines.push({ text: text.slice(cursor, newline), terminated: true });
				cursor = newline + 1;
			}
		}
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted"));
		if (this.#closed) return err(new FileError("invalid", "Text line reader is closed"));
		return ok(this.#lines[this.#index++]);
	}

	async close(_context: Context): Promise<void> {
		this.#closed = true;
	}
}

/**
 * Deterministic in-memory implementation of Pi's ExecutionEnv.
 *
 * /workspace is an immutable lazy source overlaid with in-memory mutations.
 * /tmp is fully synthetic. No host filesystem or process APIs are used.
 */
export class MemoryExecutionEnv implements ExecutionEnv {
	cwd: string;
	readonly #source?: VirtualTreeSource;
	readonly #overlay = new Map<string, MemoryEntry>();
	readonly #deleted = new Set<string>();
	readonly #changed = new Set<string>();
	readonly #env: Record<string, string>;
	readonly #now: () => number;
	readonly #git: MemoryGit;
	#logicalTime = 1_700_000_000_000;
	#tempSeq = 0;

	constructor(options: MemoryExecutionEnvOptions = {}) {
		this.cwd = normalizeAbsolute(options.cwd ?? "/workspace");
		this.#source = options.source;
		this.#env = { HOME: "/workspace", TMPDIR: "/tmp", PWD: this.cwd, ...(options.env ?? {}) };
		this.#now = options.now ?? (() => this.#logicalTime++);
		this.#overlay.set("/workspace", { kind: "directory", mtimeMs: this.#now() });
		this.#overlay.set("/tmp", { kind: "directory", mtimeMs: this.#now() });
		this.#git = new MemoryGit({
			source: this.#source,
			changedPaths: () => [...this.#changed].sort(),
			readCurrent: async (path) => {
				const absolute = resolveVirtual("/workspace", path);
				const result = await this.readBinaryFile(absolute, { abortSignal: undefined } as Context);
				return result.ok ? result.value : undefined;
			},
		});
		if (!pathInsideSyntheticRoots(this.cwd)) throw new Error(`Synthetic cwd is outside virtual roots: ${this.cwd}`);
	}

	fork(): MemoryExecutionEnv {
		const fork = new MemoryExecutionEnv({ cwd: this.cwd, source: this.#source, env: this.#env, now: this.#now });
		fork.#overlay.clear();
		for (const [path, entry] of this.#overlay) {
			fork.#overlay.set(
				path,
				entry.kind === "file"
					? { kind: "file", bytes: entry.bytes.slice(), mtimeMs: entry.mtimeMs }
					: { kind: "directory", mtimeMs: entry.mtimeMs },
			);
		}
		for (const path of this.#deleted) fork.#deleted.add(path);
		for (const path of this.#changed) fork.#changed.add(path);
		fork.#tempSeq = this.#tempSeq;
		fork.#logicalTime = this.#logicalTime;
		return fork;
	}

	async exportArtifact(): Promise<MemoryWorkspaceArtifact> {
		const revision = await this.#source?.revision();
		const changes: MemoryWorkspaceChange[] = [];
		for (const path of [...this.#changed].sort()) {
			const absolute = resolveVirtual("/workspace", path);
			const current = await this.#readCurrentBytes(absolute);
			const base = await this.#readSourceBytes(absolute);
			if (compareBytes(base, current)) continue;
			if (current === undefined) changes.push({ path, kind: "delete" });
			else if (base === undefined) changes.push({ path, kind: "add", content: current });
			else changes.push({ path, kind: "modify", content: current });
		}
		return { revision, changes };
	}

	async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		const aborted = this.#aborted<string>(context, path);
		if (aborted) return aborted;
		const absolute = resolveVirtual(this.cwd, path);
		if (!pathInsideSyntheticRoots(absolute)) return err(new FileError("permission_denied", "Path escapes synthetic roots", absolute));
		return ok(absolute);
	}

	async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		const aborted = this.#aborted<string>(context);
		if (aborted) return aborted;
		const joined = joinVirtual(parts);
		if (!pathInsideSyntheticRoots(joined)) return err(new FileError("permission_denied", "Path escapes synthetic roots", joined));
		return ok(joined);
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const binary = await this.readBinaryFile(path, context);
		return binary.ok ? ok(decoder.decode(binary.value)) : binary;
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const text = await this.readTextFile(path, context);
		return text.ok ? ok(new MemoryTextLineReader(text.value)) : text;
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split("\n");
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const absoluteResult = await this.absolutePath(path, context);
		if (!absoluteResult.ok) return absoluteResult;
		const absolute = absoluteResult.value;
		const entry = this.#overlay.get(absolute);
		if (entry?.kind === "file") return ok(entry.bytes.slice());
		if (entry?.kind === "directory") return err(new FileError("is_directory", "Path is a directory", absolute));
		if (this.#isDeleted(absolute)) return err(new FileError("not_found", "File not found", absolute));
		const relative = sourceRelative(absolute);
		if (relative !== undefined && this.#source) {
			try {
				const info = await this.#source.stat(relative);
				if (!info) return err(new FileError("not_found", "File not found", absolute));
				if (info.kind === "directory") return err(new FileError("is_directory", "Path is a directory", absolute));
				if (info.kind === "symlink") return err(new FileError("not_supported", "Synthetic symlink reads are not supported", absolute));
				return ok((await this.#source.readFile(relative)).slice());
			} catch (error) {
				return err(new FileError("unknown", error instanceof Error ? error.message : String(error), absolute));
			}
		}
		return err(new FileError("not_found", "File not found", absolute));
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const absoluteResult = await this.absolutePath(path, context);
		if (!absoluteResult.ok) return absoluteResult;
		const absolute = absoluteResult.value;
		if (absolute === "/" || absolute === "/workspace" || absolute === "/tmp") {
			return err(new FileError("is_directory", "Cannot overwrite a directory", absolute));
		}
		const parentResult = await this.#ensureDirectory(virtualParent(absolute), context);
		if (!parentResult.ok) return parentResult;
		this.#clearDeletedAncestors(absolute);
		const bytes = typeof content === "string" ? encoder.encode(content) : content.slice();
		this.#overlay.set(absolute, { kind: "file", bytes, mtimeMs: this.#now() });
		this.#markChanged(absolute);
		return ok(undefined);
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const existing = await this.readBinaryFile(path, context);
		const tail = typeof content === "string" ? encoder.encode(content) : content;
		if (!existing.ok) {
			if (existing.error.code !== "not_found") return existing;
			return this.writeFile(path, tail, context);
		}
		const combined = new Uint8Array(existing.value.byteLength + tail.byteLength);
		combined.set(existing.value, 0);
		combined.set(tail, existing.value.byteLength);
		return this.writeFile(path, combined, context);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const sourceResult = await this.absolutePath(sourcePath, context);
		if (!sourceResult.ok) return sourceResult;
		const destinationResult = await this.absolutePath(destinationPath, context);
		if (!destinationResult.ok) return destinationResult;
		const source = sourceResult.value;
		const destination = destinationResult.value;
		const info = await this.fileInfo(source, context);
		if (!info.ok) return info;
		if (info.value.kind === "directory") {
			const files = await this.#walkFiles(source, context);
			if (!files.ok) return files;
			await this.#ensureDirectory(destination, context);
			for (const file of files.value) {
				const relative = file.slice(source.length).replace(/^\//, "");
				const bytes = await this.readBinaryFile(file, context);
				if (!bytes.ok) return bytes;
				const write = await this.writeFile(`${destination}/${relative}`, bytes.value, context);
				if (!write.ok) return write;
			}
			return this.remove(source, { recursive: true, force: false }, context);
		}
		const bytes = await this.readBinaryFile(source, context);
		if (!bytes.ok) return bytes;
		const write = await this.writeFile(destination, bytes.value, context);
		if (!write.ok) return write;
		return this.remove(source, undefined, context);
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const absoluteResult = await this.absolutePath(path, context);
		if (!absoluteResult.ok) return absoluteResult;
		const absolute = absoluteResult.value;
		if (absolute === "/") return ok({ name: "/", path: "/", kind: "directory", size: 0, mtimeMs: 0 });
		const entry = this.#overlay.get(absolute);
		if (entry) {
			return ok({
				name: virtualBasename(absolute),
				path: absolute,
				kind: entry.kind,
				size: entry.kind === "file" ? entry.bytes.byteLength : 0,
				mtimeMs: entry.mtimeMs,
			});
		}
		if (this.#isDeleted(absolute)) return err(new FileError("not_found", "Path not found", absolute));
		const relative = sourceRelative(absolute);
		if (relative !== undefined && this.#source) {
			try {
				const info = await this.#source.stat(relative);
				if (!info) return err(new FileError("not_found", "Path not found", absolute));
				return ok(this.#sourceInfoToFileInfo(absolute, info));
			} catch (error) {
				return err(new FileError("unknown", error instanceof Error ? error.message : String(error), absolute));
			}
		}
		return err(new FileError("not_found", "Path not found", absolute));
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const absoluteResult = await this.absolutePath(path, context);
		if (!absoluteResult.ok) return absoluteResult;
		const absolute = absoluteResult.value;
		const info = await this.fileInfo(absolute, context);
		if (!info.ok) return info;
		if (info.value.kind !== "directory") return err(new FileError("not_directory", "Path is not a directory", absolute));
		const children = new Map<string, FileInfo>();

		if (absolute === "/") {
			for (const child of ["/workspace", "/tmp"]) {
				const childInfo = await this.fileInfo(child, context);
				if (childInfo.ok) children.set(childInfo.value.name, childInfo.value);
			}
		}

		const relative = sourceRelative(absolute);
		if (relative !== undefined && this.#source && !this.#isDeleted(absolute)) {
			try {
				for (const child of await this.#source.listDir(relative)) {
					const childAbsolute = resolveVirtual("/workspace", child.path);
					if (this.#isDeleted(childAbsolute)) continue;
					const shadow = this.#overlay.get(childAbsolute);
					children.set(
						virtualBasename(childAbsolute),
						shadow
							? {
									name: virtualBasename(childAbsolute),
									path: childAbsolute,
									kind: shadow.kind,
									size: shadow.kind === "file" ? shadow.bytes.byteLength : 0,
									mtimeMs: shadow.mtimeMs,
								}
							: this.#sourceInfoToFileInfo(childAbsolute, child),
					);
				}
			} catch (error) {
				return err(new FileError("unknown", error instanceof Error ? error.message : String(error), absolute));
			}
		}

		for (const [candidate, entry] of this.#overlay) {
			if (candidate === absolute || virtualParent(candidate) !== absolute || this.#isDeleted(candidate)) continue;
			children.set(virtualBasename(candidate), {
				name: virtualBasename(candidate),
				path: candidate,
				kind: entry.kind,
				size: entry.kind === "file" ? entry.bytes.byteLength : 0,
				mtimeMs: entry.mtimeMs,
			});
		}

		return ok([...children.values()].sort((a, b) => a.name.localeCompare(b.name)));
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const absolute = await this.absolutePath(path, context);
		if (!absolute.ok) return absolute;
		const exists = await this.exists(absolute.value, context);
		if (!exists.ok) return exists;
		return exists.value ? ok(absolute.value) : err(new FileError("not_found", "Path not found", absolute.value));
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const info = await this.fileInfo(path, context);
		if (info.ok) return ok(true);
		if (info.error.code === "not_found") return ok(false);
		return info;
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const absoluteResult = await this.absolutePath(path, context);
		if (!absoluteResult.ok) return absoluteResult;
		const absolute = absoluteResult.value;
		if (options?.recursive === false) {
			const parentInfo = await this.fileInfo(virtualParent(absolute), context);
			if (!parentInfo.ok) return parentInfo;
			if (parentInfo.value.kind !== "directory") return err(new FileError("not_directory", "Parent is not a directory", virtualParent(absolute)));
		}
		return this.#ensureDirectory(absolute, context);
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const absoluteResult = await this.absolutePath(path, context);
		if (!absoluteResult.ok) return absoluteResult;
		const absolute = absoluteResult.value;
		if (absolute === "/" || absolute === "/workspace" || absolute === "/tmp") {
			return err(new FileError("permission_denied", "Cannot remove synthetic root", absolute));
		}
		const info = await this.fileInfo(absolute, context);
		if (!info.ok) {
			if (options?.force && info.error.code === "not_found") return ok(undefined);
			return info;
		}
		if (info.value.kind === "directory") {
			const children = await this.listDir(absolute, context);
			if (!children.ok) return children;
			if (children.value.length > 0 && !options?.recursive) return err(new FileError("invalid", "Directory is not empty", absolute));
			if (options?.recursive) {
				for (const child of children.value) {
					const removed = await this.remove(child.path, { recursive: true, force: true }, context);
					if (!removed.ok) return removed;
				}
			}
		}
		this.#overlay.delete(absolute);
		this.#deleted.add(absolute);
		this.#markChanged(absolute);
		return ok(undefined);
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		for (;;) {
			const path = `/tmp/${prefix ?? "tmp-"}${++this.#tempSeq}`;
			const exists = await this.exists(path, context);
			if (!exists.ok) return exists;
			if (exists.value) continue;
			const created = await this.createDir(path, { recursive: true }, context);
			return created.ok ? ok(path) : created;
		}
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		for (;;) {
			const path = `/tmp/${options?.prefix ?? ""}${++this.#tempSeq}${options?.suffix ?? ""}`;
			const exists = await this.exists(path, context);
			if (!exists.ok) return exists;
			if (exists.value) continue;
			const created = await this.writeFile(path, new Uint8Array(), context);
			return created.ok ? ok(path) : created;
		}
	}

	async exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const shellState: ShellState = {
			cwd: options?.cwd ? resolveVirtual(this.cwd, options.cwd) : this.cwd,
			env: options?.inheritEnv === false ? { ...(options.env ?? {}) } : { ...this.#env, ...(options?.env ?? {}) },
		};
		if (!pathInsideSyntheticRoots(shellState.cwd)) return err(new ExecutionError("spawn_error", `Working directory does not exist: ${shellState.cwd}`));
		const cwdInfo = await this.fileInfo(shellState.cwd, context);
		if (!cwdInfo.ok || cwdInfo.value.kind !== "directory") return err(new ExecutionError("spawn_error", `Working directory does not exist: ${shellState.cwd}`));

		let callbackError: Error | undefined;
		const capture = new OutputCapture(options?.capture, context, {
			onUpdate: options?.onUpdate,
			onError: (error) => {
				callbackError = error instanceof Error ? error : new Error(String(error));
			},
		});
		const startedAt = Date.now();
		try {
			const result = await this.#runScript(command, shellState, context, options?.timeout, startedAt);
			const combined = `${result.stdout}${result.stderr}`;
			capture.push(combined);
			capture.finish();
			if (capture.truncated && options?.capture?.spill) {
				const spill = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context);
				if (!spill.ok) return err(new ExecutionError("unknown", spill.error.message, spill.error));
				const wrote = await this.writeFile(spill.value, combined, context);
				if (!wrote.ok) return err(new ExecutionError("unknown", wrote.error.message, wrote.error));
				capture.setSpillPath(spill.value);
			}
			capture.flush();
			if (callbackError) return err(new ExecutionError("callback_error", callbackError.message, callbackError));
			const view = capture.snapshot();
			return ok({
				exitCode: result.exitCode,
				truncation: view.truncation,
				...(view.spillPath === undefined ? {} : { spillPath: view.spillPath }),
				...(view.lastLineBytes === undefined ? {} : { lastLineBytes: view.lastLineBytes }),
			});
		} catch (error) {
			if (error instanceof ExecutionError) return err(error);
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		} finally {
			capture.dispose();
		}
	}

	async cleanup(_context: Context): Promise<void> {}

	async #runScript(
		command: string,
		state: ShellState,
		context: Context,
		timeoutSeconds: number | undefined,
		startedAt: number,
	): Promise<CommandResult> {
		const chunks = splitShell(command, ["&&", "||", ";"]);
		let aggregate = "";
		let lastCode = 0;
		let pendingOperator: string | undefined;
		for (const chunk of chunks) {
			this.#checkExecution(context, timeoutSeconds, startedAt);
			if (chunk.kind === "operator") {
				pendingOperator = chunk.value;
				continue;
			}
			if (pendingOperator === "&&" && lastCode !== 0) {
				pendingOperator = undefined;
				continue;
			}
			if (pendingOperator === "||" && lastCode === 0) {
				pendingOperator = undefined;
				continue;
			}
			pendingOperator = undefined;
			const result = await this.#runPipeline(chunk.value, state, context, timeoutSeconds, startedAt);
			aggregate += result.stdout + result.stderr;
			lastCode = result.exitCode;
		}
		return { stdout: aggregate, stderr: "", exitCode: lastCode };
	}

	async #runPipeline(
		text: string,
		state: ShellState,
		context: Context,
		timeoutSeconds: number | undefined,
		startedAt: number,
	): Promise<CommandResult> {
		const parts = splitShell(text, ["|"]).filter((part) => part.kind === "text").map((part) => part.value);
		let stdin = "";
		let stderr = "";
		let exitCode = 0;
		for (const part of parts) {
			this.#checkExecution(context, timeoutSeconds, startedAt);
			const parsed = parseRedirection(part, state.env);
			const result = await this.#runCommand(parsed.command, stdin, state, context);
			stdin = result.stdout;
			stderr += result.stderr;
			exitCode = result.exitCode;
			if (parsed.redirect) {
				const path = resolveVirtual(state.cwd, parsed.redirect.path);
				const write = parsed.redirect.append
					? await this.appendFile(path, stdin, context)
					: await this.writeFile(path, stdin, context);
				if (!write.ok) return { stdout: "", stderr: `${write.error.message}\n`, exitCode: 1 };
				stdin = "";
			}
			if (exitCode !== 0) break;
		}
		return { stdout: stdin, stderr, exitCode };
	}

	async #runCommand(text: string, stdin: string, state: ShellState, context: Context): Promise<CommandResult> {
		const argv = shellWords(text, state.env);
		if (argv.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
		const [name, ...args] = argv;
		switch (name) {
			case "true":
				return { stdout: "", stderr: "", exitCode: 0 };
			case "false":
				return { stdout: "", stderr: "", exitCode: 1 };
			case "pwd":
				return { stdout: `${state.cwd}\n`, stderr: "", exitCode: 0 };
			case "cd": {
				const next = resolveVirtual(state.cwd, args[0] ?? "/workspace");
				const info = await this.fileInfo(next, context);
				if (!info.ok || info.value.kind !== "directory") return { stdout: "", stderr: `cd: ${args[0] ?? ""}: No such directory\n`, exitCode: 1 };
				state.cwd = next;
				state.env.PWD = next;
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			case "echo":
				return { stdout: `${args.join(" ")}\n`, stderr: "", exitCode: 0 };
			case "printf":
				return { stdout: formatPrintf(args), stderr: "", exitCode: 0 };
			case "cat":
				return this.#cmdCat(args, stdin, state, context);
			case "ls":
				return this.#cmdLs(args, state, context);
			case "head":
				return this.#cmdHeadTail(args, stdin, state, context, true);
			case "tail":
				return this.#cmdHeadTail(args, stdin, state, context, false);
			case "wc":
				return this.#cmdWc(args, stdin, state, context);
			case "grep":
				return this.#cmdGrep(args, stdin, state, context);
			case "find":
				return this.#cmdFind(args, state, context);
			case "mkdir":
				return this.#cmdMkdir(args, state, context);
			case "rm":
				return this.#cmdRm(args, state, context);
			case "cp":
				return this.#cmdCp(args, state, context);
			case "mv":
				return this.#cmdMv(args, state, context);
			case "touch":
				return this.#cmdTouch(args, state, context);
			case "sort":
				return this.#cmdSort(args, stdin, state, context);
			case "uniq":
				return this.#cmdUniq(args, stdin, state, context);
			case "git":
				return this.#git.run(args);
			default:
				return { stdout: "", stderr: `synthetic-shell: ${name}: command not available in synthetic environment\n`, exitCode: 127 };
		}
	}

	async #cmdCat(args: string[], stdin: string, state: ShellState, context: Context): Promise<CommandResult> {
		if (args.length === 0) return { stdout: stdin, stderr: "", exitCode: 0 };
		let stdout = "";
		for (const arg of args) {
			const read = await this.readTextFile(resolveVirtual(state.cwd, arg), context);
			if (!read.ok) return { stdout, stderr: `cat: ${arg}: ${read.error.message}\n`, exitCode: 1 };
			stdout += read.value;
		}
		return { stdout, stderr: "", exitCode: 0 };
	}

	async #cmdLs(args: string[], state: ShellState, context: Context): Promise<CommandResult> {
		const long = args.some((arg) => arg.includes("l") && arg.startsWith("-"));
		const paths = args.filter((arg) => !arg.startsWith("-"));
		const target = resolveVirtual(state.cwd, paths[0] ?? ".");
		const listing = await this.listDir(target, context);
		if (!listing.ok) return { stdout: "", stderr: `ls: ${paths[0] ?? "."}: ${listing.error.message}\n`, exitCode: 1 };
		if (!long) return { stdout: listing.value.length ? `${listing.value.map((entry) => entry.name).join("\n")}\n` : "", stderr: "", exitCode: 0 };
		return {
			stdout: listing.value.map((entry) => `${entry.kind === "directory" ? "d" : "-"}rw-r--r-- 1 synthetic synthetic ${entry.size} ${entry.name}`).join("\n") + (listing.value.length ? "\n" : ""),
			stderr: "",
			exitCode: 0,
		};
	}

	async #cmdHeadTail(args: string[], stdin: string, state: ShellState, context: Context, head: boolean): Promise<CommandResult> {
		let count = 10;
		const files: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if ((args[i] === "-n" || args[i] === "--lines") && args[i + 1]) count = Math.max(0, Number(args[++i]) || 0);
			else if (/^-\d+$/.test(args[i]!)) count = Number(args[i]!.slice(1));
			else files.push(args[i]!);
		}
		let input = stdin;
		if (files.length > 0) {
			const read = await this.readTextFile(resolveVirtual(state.cwd, files[0]!), context);
			if (!read.ok) return { stdout: "", stderr: `${head ? "head" : "tail"}: ${files[0]}: ${read.error.message}\n`, exitCode: 1 };
			input = read.value;
		}
		const lines = input.split("\n");
		const selected = head ? lines.slice(0, count) : lines.slice(Math.max(0, lines.length - count));
		return { stdout: selected.join("\n"), stderr: "", exitCode: 0 };
	}

	async #cmdWc(args: string[], stdin: string, state: ShellState, context: Context): Promise<CommandResult> {
		const files = args.filter((arg) => !arg.startsWith("-"));
		let input = stdin;
		if (files.length > 0) {
			const read = await this.readTextFile(resolveVirtual(state.cwd, files[0]!), context);
			if (!read.ok) return { stdout: "", stderr: `wc: ${files[0]}: ${read.error.message}\n`, exitCode: 1 };
			input = read.value;
		}
		const bytes = encoder.encode(input).byteLength;
		const lines = input.length === 0 ? 0 : input.split("\n").length - (input.endsWith("\n") ? 1 : 0);
		const words = input.trim() ? input.trim().split(/\s+/).length : 0;
		if (args.includes("-l")) return { stdout: `${lines}\n`, stderr: "", exitCode: 0 };
		if (args.includes("-w")) return { stdout: `${words}\n`, stderr: "", exitCode: 0 };
		if (args.includes("-c")) return { stdout: `${bytes}\n`, stderr: "", exitCode: 0 };
		return { stdout: `${lines} ${words} ${bytes}\n`, stderr: "", exitCode: 0 };
	}

	async #cmdGrep(args: string[], stdin: string, state: ShellState, context: Context): Promise<CommandResult> {
		let recursive = false;
		let lineNumbers = false;
		let ignoreCase = false;
		let pattern: string | undefined;
		const paths: string[] = [];
		for (const arg of args) {
			if (arg.startsWith("-") && pattern === undefined) {
				recursive ||= arg.includes("R") || arg.includes("r");
				lineNumbers ||= arg.includes("n");
				ignoreCase ||= arg.includes("i");
				continue;
			}
			if (pattern === undefined) pattern = arg;
			else paths.push(arg);
		}
		if (pattern === undefined) return { stdout: "", stderr: "grep: missing pattern\n", exitCode: 2 };
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		const matches: string[] = [];
		const scan = (text: string, label?: string) => {
			text.split("\n").forEach((line, index) => {
				const hay = ignoreCase ? line.toLowerCase() : line;
				if (!hay.includes(needle)) return;
				const prefix = `${label ? `${label}:` : ""}${lineNumbers ? `${index + 1}:` : ""}`;
				matches.push(`${prefix}${line}`);
			});
		};
		if (paths.length === 0) scan(stdin);
		else {
			for (const path of paths) {
				const absolute = resolveVirtual(state.cwd, path);
				const info = await this.fileInfo(absolute, context);
				if (!info.ok) continue;
				if (info.value.kind === "directory") {
					if (!recursive) continue;
					const walked = await this.#walkFiles(absolute, context);
					if (!walked.ok) continue;
					for (const file of walked.value) {
						const read = await this.readTextFile(file, context);
						if (read.ok) scan(read.value, this.#displayPath(file, state.cwd));
					}
				} else {
					const read = await this.readTextFile(absolute, context);
					if (read.ok) scan(read.value, paths.length > 1 ? path : undefined);
				}
			}
		}
		return { stdout: matches.length ? `${matches.join("\n")}\n` : "", stderr: "", exitCode: matches.length ? 0 : 1 };
	}

	async #cmdFind(args: string[], state: ShellState, context: Context): Promise<CommandResult> {
		const rootArg = args.find((arg) => !arg.startsWith("-")) ?? ".";
		const nameIndex = args.indexOf("-name");
		const namePattern = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
		const typeIndex = args.indexOf("-type");
		const type = typeIndex >= 0 ? args[typeIndex + 1] : undefined;
		const root = resolveVirtual(state.cwd, rootArg);
		const entries = await this.#walk(root, context);
		if (!entries.ok) return { stdout: "", stderr: `find: ${rootArg}: ${entries.error.message}\n`, exitCode: 1 };
		const matcher = namePattern ? wildcardToRegExp(namePattern) : undefined;
		const lines = entries.value
			.filter((entry) => !matcher || matcher.test(entry.name))
			.filter((entry) => !type || (type === "f" ? entry.kind === "file" : type === "d" ? entry.kind === "directory" : true))
			.map((entry) => this.#displayPath(entry.path, state.cwd));
		return { stdout: lines.length ? `${lines.join("\n")}\n` : "", stderr: "", exitCode: 0 };
	}

	async #cmdMkdir(args: string[], state: ShellState, context: Context): Promise<CommandResult> {
		const recursive = args.includes("-p");
		for (const arg of args.filter((value) => !value.startsWith("-"))) {
			const created = await this.createDir(resolveVirtual(state.cwd, arg), { recursive }, context);
			if (!created.ok) return { stdout: "", stderr: `mkdir: ${arg}: ${created.error.message}\n`, exitCode: 1 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	async #cmdRm(args: string[], state: ShellState, context: Context): Promise<CommandResult> {
		const recursive = args.some((arg) => arg === "-r" || arg === "-R" || arg === "-rf" || arg === "-fr");
		const force = args.some((arg) => arg === "-f" || arg === "-rf" || arg === "-fr");
		for (const arg of args.filter((value) => !value.startsWith("-"))) {
			const removed = await this.remove(resolveVirtual(state.cwd, arg), { recursive, force }, context);
			if (!removed.ok) return { stdout: "", stderr: `rm: ${arg}: ${removed.error.message}\n`, exitCode: 1 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	async #cmdCp(args: string[], state: ShellState, context: Context): Promise<CommandResult> {
		const paths = args.filter((arg) => !arg.startsWith("-"));
		if (paths.length !== 2) return { stdout: "", stderr: "cp: expected source and destination\n", exitCode: 2 };
		const source = resolveVirtual(state.cwd, paths[0]!);
		const destination = resolveVirtual(state.cwd, paths[1]!);
		const bytes = await this.readBinaryFile(source, context);
		if (!bytes.ok) return { stdout: "", stderr: `cp: ${paths[0]}: ${bytes.error.message}\n`, exitCode: 1 };
		const wrote = await this.writeFile(destination, bytes.value, context);
		return wrote.ok ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `cp: ${paths[1]}: ${wrote.error.message}\n`, exitCode: 1 };
	}

	async #cmdMv(args: string[], state: ShellState, context: Context): Promise<CommandResult> {
		const paths = args.filter((arg) => !arg.startsWith("-"));
		if (paths.length !== 2) return { stdout: "", stderr: "mv: expected source and destination\n", exitCode: 2 };
		const moved = await this.renameFile(resolveVirtual(state.cwd, paths[0]!), resolveVirtual(state.cwd, paths[1]!), context);
		return moved.ok ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `mv: ${moved.error.message}\n`, exitCode: 1 };
	}

	async #cmdTouch(args: string[], state: ShellState, context: Context): Promise<CommandResult> {
		for (const arg of args.filter((value) => !value.startsWith("-"))) {
			const path = resolveVirtual(state.cwd, arg);
			const existing = await this.readBinaryFile(path, context);
			const wrote = await this.writeFile(path, existing.ok ? existing.value : new Uint8Array(), context);
			if (!wrote.ok) return { stdout: "", stderr: `touch: ${arg}: ${wrote.error.message}\n`, exitCode: 1 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	async #cmdSort(args: string[], stdin: string, state: ShellState, context: Context): Promise<CommandResult> {
		let input = stdin;
		const path = args.find((arg) => !arg.startsWith("-"));
		if (path) {
			const read = await this.readTextFile(resolveVirtual(state.cwd, path), context);
			if (!read.ok) return { stdout: "", stderr: `sort: ${path}: ${read.error.message}\n`, exitCode: 1 };
			input = read.value;
		}
		const lines = input.split("\n").sort((a, b) => a.localeCompare(b));
		return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
	}

	async #cmdUniq(args: string[], stdin: string, state: ShellState, context: Context): Promise<CommandResult> {
		let input = stdin;
		const path = args.find((arg) => !arg.startsWith("-"));
		if (path) {
			const read = await this.readTextFile(resolveVirtual(state.cwd, path), context);
			if (!read.ok) return { stdout: "", stderr: `uniq: ${path}: ${read.error.message}\n`, exitCode: 1 };
			input = read.value;
		}
		const lines = input.split("\n");
		const unique = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
		return { stdout: unique.join("\n"), stderr: "", exitCode: 0 };
	}

	#checkExecution(context: Context, timeoutSeconds: number | undefined, startedAt: number): void {
		if (context.abortSignal?.aborted) throw new ExecutionError("aborted", "aborted");
		if (timeoutSeconds !== undefined && Date.now() - startedAt > timeoutSeconds * 1000) {
			throw new ExecutionError("timeout", `Command timed out after ${timeoutSeconds} seconds`);
		}
	}

	#aborted<T>(context: Context, path?: string): Result<T, FileError> | undefined {
		return context.abortSignal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
	}

	#markChanged(absolute: string): void {
		const relative = sourceRelative(absolute);
		if (relative !== undefined && relative !== "") this.#changed.add(relative);
	}

	#isDeleted(path: string): boolean {
		for (const deleted of this.#deleted) if (path === deleted || path.startsWith(`${deleted}/`)) return true;
		return false;
	}

	#clearDeletedAncestors(path: string): void {
		for (const deleted of [...this.#deleted]) {
			if (path === deleted || path.startsWith(`${deleted}/`) || deleted.startsWith(`${path}/`)) this.#deleted.delete(deleted);
		}
	}

	async #ensureDirectory(path: string, context: Context): Promise<Result<void, FileError>> {
		const normalized = normalizeAbsolute(path);
		if (!pathInsideSyntheticRoots(normalized)) return err(new FileError("permission_denied", "Path escapes synthetic roots", normalized));
		if (normalized === "/") return ok(undefined);
		const existing = await this.fileInfo(normalized, context);
		if (existing.ok) {
			if (existing.value.kind !== "directory") return err(new FileError("not_directory", "Path is not a directory", normalized));
			return ok(undefined);
		}
		if (existing.error.code !== "not_found") return existing;
		const parent = await this.#ensureDirectory(virtualParent(normalized), context);
		if (!parent.ok) return parent;
		this.#clearDeletedAncestors(normalized);
		this.#overlay.set(normalized, { kind: "directory", mtimeMs: this.#now() });
		return ok(undefined);
	}

	#sourceInfoToFileInfo(absolute: string, info: VirtualSourceInfo): FileInfo {
		return {
			name: virtualBasename(absolute),
			path: absolute,
			kind: info.kind,
			size: info.size,
			mtimeMs: info.mtimeMs,
		};
	}

	async #readSourceBytes(absolute: string): Promise<Uint8Array | undefined> {
		const relative = sourceRelative(absolute);
		if (relative === undefined || !this.#source) return undefined;
		try {
			const info = await this.#source.stat(relative);
			if (!info || info.kind !== "file") return undefined;
			return await this.#source.readFile(relative);
		} catch {
			return undefined;
		}
	}

	async #readCurrentBytes(absolute: string): Promise<Uint8Array | undefined> {
		const context = { abortSignal: undefined } as Context;
		const result = await this.readBinaryFile(absolute, context);
		return result.ok ? result.value : undefined;
	}

	async #walkFiles(root: string, context: Context): Promise<Result<string[], FileError>> {
		const entries = await this.#walk(root, context);
		return entries.ok ? ok(entries.value.filter((entry) => entry.kind === "file").map((entry) => entry.path)) : entries;
	}

	async #walk(root: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const rootInfo = await this.fileInfo(root, context);
		if (!rootInfo.ok) return rootInfo;
		const result: FileInfo[] = [];
		const stack = [rootInfo.value];
		while (stack.length > 0) {
			const current = stack.pop()!;
			result.push(current);
			if (current.kind !== "directory") continue;
			const children = await this.listDir(current.path, context);
			if (!children.ok) return children;
			for (let index = children.value.length - 1; index >= 0; index--) stack.push(children.value[index]!);
		}
		return ok(result);
	}

	#displayPath(path: string, cwd: string): string {
		if (path === cwd) return ".";
		if (path.startsWith(`${cwd}/`)) return `./${path.slice(cwd.length + 1)}`;
		return path;
	}
}

interface ShellChunk {
	kind: "text" | "operator";
	value: string;
}

function splitShell(input: string, operators: readonly string[]): ShellChunk[] {
	const sorted = [...operators].sort((a, b) => b.length - a.length);
	const chunks: ShellChunk[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let start = 0;
	for (let i = 0; i < input.length; i++) {
		const char = input[i]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		const operator = sorted.find((candidate) => input.startsWith(candidate, i));
		if (!operator) continue;
		const before = input.slice(start, i).trim();
		if (before) chunks.push({ kind: "text", value: before });
		chunks.push({ kind: "operator", value: operator });
		i += operator.length - 1;
		start = i + 1;
	}
	const tail = input.slice(start).trim();
	if (tail) chunks.push({ kind: "text", value: tail });
	return chunks;
}

function shellWords(input: string, env: Record<string, string>): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let touched = false;
	const flush = () => {
		if (touched) words.push(current);
		current = "";
		touched = false;
	};
	for (let i = 0; i < input.length; i++) {
		const char = input[i]!;
		if (escaped) {
			current += char;
			escaped = false;
			touched = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			touched = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
				touched = true;
				continue;
			}
			if (char === "$" && quote === '"') {
				const match = input.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
				if (match) {
					current += env[match[1]!] ?? "";
					i += match[1]!.length;
					touched = true;
					continue;
				}
			}
			current += char;
			touched = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			touched = true;
			continue;
		}
		if (/\s/.test(char)) {
			flush();
			continue;
		}
		if (char === "$") {
			const match = input.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
			if (match) {
				current += env[match[1]!] ?? "";
				i += match[1]!.length;
				touched = true;
				continue;
			}
		}
		current += char;
		touched = true;
	}
	flush();
	return words;
}

function parseRedirection(input: string, env: Record<string, string>): {
	command: string;
	redirect?: { path: string; append: boolean };
} {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let i = 0; i < input.length; i++) {
		const char = input[i]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char !== ">") continue;
		const append = input[i + 1] === ">";
		const rhs = input.slice(i + (append ? 2 : 1)).trim();
		const path = shellWords(rhs, env)[0];
		if (!path) break;
		return { command: input.slice(0, i).trim(), redirect: { path, append } };
	}
	return { command: input.trim() };
}

function formatPrintf(args: readonly string[]): string {
	if (args.length === 0) return "";
	const format = args[0]!;
	let index = 1;
	return format.replace(/%s|%d|%%|\\n|\\t/g, (token) => {
		switch (token) {
			case "%s":
				return args[index++] ?? "";
			case "%d":
				return String(Number(args[index++] ?? "0"));
			case "%%":
				return "%";
			case "\\n":
				return "\n";
			case "\\t":
				return "\t";
			default:
				return token;
		}
	});
}

export function describeSyntheticCommand(command: string): string {
	return `${shellQuote(command)} executes in MemoryExecutionEnv only; unsupported programs never fall through to the host.`;
}
