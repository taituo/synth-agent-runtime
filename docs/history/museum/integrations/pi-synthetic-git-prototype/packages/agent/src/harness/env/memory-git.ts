import { generateUnifiedPatch } from "../tools/edit-diff.ts";
import type { VirtualTreeSource, WorkspaceRevision } from "./memory-source.ts";

const decoder = new TextDecoder("utf-8", { fatal: false });

export interface MemoryGitWorkspaceView {
	readonly source?: VirtualTreeSource;
	changedPaths(): readonly string[];
	readCurrent(path: string): Promise<Uint8Array | undefined>;
}

export interface SyntheticGitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function equalBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

function isProbablyBinary(bytes: Uint8Array): boolean {
	const limit = Math.min(bytes.byteLength, 8192);
	for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
	return false;
}

function countPatchChanges(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function parsePathFilter(args: readonly string[]): string[] {
	const separator = args.indexOf("--");
	if (separator === -1) return [];
	return args.slice(separator + 1).filter((value) => !value.startsWith("-"));
}

function matchesFilter(path: string, filters: readonly string[]): boolean {
	if (filters.length === 0) return true;
	return filters.some((filter) => path === filter || path.startsWith(`${filter.replace(/\/$/, "")}/`));
}

export class MemoryGit {
	readonly #view: MemoryGitWorkspaceView;

	constructor(view: MemoryGitWorkspaceView) {
		this.#view = view;
	}

	async run(args: readonly string[]): Promise<SyntheticGitResult> {
		const [command, ...rest] = args;
		switch (command) {
			case "status":
				return this.#status(rest);
			case "diff":
				return this.#diff(rest);
			case "rev-parse":
				return this.#revParse(rest);
			case "show":
				return this.#show(rest);
			case "ls-files":
				return this.#lsFiles(rest);
			case "branch":
				return this.#branch(rest);
			default:
				return {
					stdout: "",
					stderr: `synthetic-git: unsupported command: git ${args.join(" ")}\n`,
					exitCode: 2,
				};
		}
	}

	async #revision(): Promise<WorkspaceRevision | undefined> {
		return this.#view.source?.revision();
	}

	async #base(path: string): Promise<Uint8Array | undefined> {
		const source = this.#view.source;
		if (!source) return undefined;
		const info = await source.stat(path);
		if (!info || info.kind !== "file") return undefined;
		return source.readFile(path);
	}

	async #classify(path: string): Promise<"A" | "M" | "D" | undefined> {
		const [base, current] = await Promise.all([this.#base(path), this.#view.readCurrent(path)]);
		if (base === undefined && current !== undefined) return "A";
		if (base !== undefined && current === undefined) return "D";
		if (!equalBytes(base, current)) return "M";
		return undefined;
	}

	async #status(args: readonly string[]): Promise<SyntheticGitResult> {
		const short = args.includes("--short") || args.includes("-s");
		const filters = parsePathFilter(args);
		const lines: string[] = [];
		for (const path of [...new Set(this.#view.changedPaths())].sort()) {
			if (!matchesFilter(path, filters)) continue;
			const status = await this.#classify(path);
			if (!status) continue;
			lines.push(`${status === "A" ? "??" : ` ${status}`} ${path}`);
		}
		if (short) return { stdout: lines.length ? `${lines.join("\n")}\n` : "", stderr: "", exitCode: 0 };
		const revision = await this.#revision();
		const branch = revision?.ref ?? "synthetic";
		if (lines.length === 0) {
			return {
				stdout: `On branch ${branch}\nnothing to commit, working tree clean\n`,
				stderr: "",
				exitCode: 0,
			};
		}
		return {
			stdout: `On branch ${branch}\nChanges not staged for commit:\n${lines.map((line) => `\t${line}`).join("\n")}\n`,
			stderr: "",
			exitCode: 0,
		};
	}

	async #diff(args: readonly string[]): Promise<SyntheticGitResult> {
		const statOnly = args.includes("--stat");
		const filters = parsePathFilter(args);
		const patches: string[] = [];
		const stats: string[] = [];
		let totalAdded = 0;
		let totalRemoved = 0;

		for (const path of [...new Set(this.#view.changedPaths())].sort()) {
			if (!matchesFilter(path, filters)) continue;
			const [base, current] = await Promise.all([this.#base(path), this.#view.readCurrent(path)]);
			if (equalBytes(base, current)) continue;
			const before = base ?? new Uint8Array();
			const after = current ?? new Uint8Array();
			if (isProbablyBinary(before) || isProbablyBinary(after)) {
				const patch = `diff --git a/${path} b/${path}\nBinary files a/${path} and b/${path} differ\n`;
				patches.push(patch);
				stats.push(` ${path} | Bin`);
				continue;
			}
			const oldText = decoder.decode(before);
			const newText = decoder.decode(after);
			const body = generateUnifiedPatch(path, oldText, newText);
			const patch = `diff --git a/${path} b/${path}\n${body}`;
			patches.push(patch.endsWith("\n") ? patch : `${patch}\n`);
			const counts = countPatchChanges(body);
			totalAdded += counts.added;
			totalRemoved += counts.removed;
			stats.push(` ${path} | ${counts.added + counts.removed} ${"+".repeat(Math.min(counts.added, 20))}${"-".repeat(Math.min(counts.removed, 20))}`);
		}

		if (statOnly) {
			if (stats.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
			return {
				stdout: `${stats.join("\n")}\n ${stats.length} file${stats.length === 1 ? "" : "s"} changed, ${totalAdded} insertion${totalAdded === 1 ? "" : "s"}(+), ${totalRemoved} deletion${totalRemoved === 1 ? "" : "s"}(-)\n`,
				stderr: "",
				exitCode: 0,
			};
		}
		return { stdout: patches.join(""), stderr: "", exitCode: 0 };
	}

	async #revParse(args: readonly string[]): Promise<SyntheticGitResult> {
		if (args.length !== 1 || args[0] !== "HEAD") {
			return { stdout: "", stderr: "synthetic-git: rev-parse only supports HEAD\n", exitCode: 2 };
		}
		const revision = await this.#revision();
		return {
			stdout: `${revision?.commit ?? "0000000000000000000000000000000000000000"}\n`,
			stderr: "",
			exitCode: 0,
		};
	}

	async #branch(args: readonly string[]): Promise<SyntheticGitResult> {
		if (args.length > 0 && !args.includes("--show-current")) {
			return { stdout: "", stderr: "synthetic-git: branch mutation is not supported\n", exitCode: 2 };
		}
		const revision = await this.#revision();
		const ref = revision?.ref ?? "synthetic";
		const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		return { stdout: `${branch}\n`, stderr: "", exitCode: 0 };
	}

	async #show(args: readonly string[]): Promise<SyntheticGitResult> {
		if (args.length !== 1 || !args[0]!.startsWith("HEAD:")) {
			return { stdout: "", stderr: "synthetic-git: show supports HEAD:<path> only\n", exitCode: 2 };
		}
		const path = args[0]!.slice("HEAD:".length).replace(/^\.\//, "");
		const base = await this.#base(path);
		if (!base) return { stdout: "", stderr: `fatal: path '${path}' does not exist in 'HEAD'\n`, exitCode: 128 };
		return { stdout: decoder.decode(base), stderr: "", exitCode: 0 };
	}

	async #lsFiles(args: readonly string[]): Promise<SyntheticGitResult> {
		if (args.some((arg) => arg.startsWith("-") && arg !== "--")) {
			return { stdout: "", stderr: "synthetic-git: ls-files options are not implemented\n", exitCode: 2 };
		}
		const filters = parsePathFilter(args);
		const source = this.#view.source;
		const files = new Set<string>();
		if (source?.listFiles) {
			for await (const path of source.listFiles()) if (matchesFilter(path, filters)) files.add(path);
		}
		for (const path of this.#view.changedPaths()) {
			const current = await this.#view.readCurrent(path);
			const base = await this.#base(path);
			if ((base !== undefined || current !== undefined) && matchesFilter(path, filters)) files.add(path);
		}
		return { stdout: files.size ? `${[...files].sort().join("\n")}\n` : "", stderr: "", exitCode: 0 };
	}
}
