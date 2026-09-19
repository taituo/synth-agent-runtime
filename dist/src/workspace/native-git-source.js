import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitCatFileBatch } from "./git-batch.js";
import { normalizeRelative } from "./source.js";
const execFileAsync = promisify(execFile);
function parseLsTreeZ(buffer) {
    const text = buffer.toString("utf8");
    const out = [];
    for (const record of text.split("\0")) {
        if (!record)
            continue;
        const tab = record.indexOf("\t");
        if (tab < 0)
            continue;
        const left = record.slice(0, tab).split(" ");
        if (left.length < 3)
            continue;
        out.push({ mode: left[0], type: left[1], objectId: left[2], name: record.slice(tab + 1) });
    }
    return out;
}
/**
 * Checkout-less native Git source.
 *
 * The backing repository is a bare partial clone. Agent mutations never touch it;
 * the MemoryWorkspace overlay remains RAM-only. `blob:none` lets Git lazily fetch
 * blobs from the promisor remote when a file is first read.
 */
export class NativeGitSource {
    name;
    #gitDir;
    #remote;
    #ref;
    #depth;
    #filter;
    #sparse;
    #git;
    #maxBlobBytes;
    #commit;
    #batch;
    constructor(options) {
        this.#gitDir = resolve(options.gitDir);
        this.#remote = options.remote;
        this.#ref = options.ref ?? "HEAD";
        this.#depth = options.depth ?? 1;
        this.#filter = options.filter ?? "blob:none";
        this.#sparse = (options.sparse ?? []).map(normalizeRelative).filter(Boolean);
        this.#git = options.gitBin ?? "git";
        this.#maxBlobBytes = options.maxBlobBytes ?? 32 * 1024 * 1024;
        // A ref/remote starting with '-' is parsed by git as an option (e.g.
        // `--upload-pack=<cmd>`), not a value, and can run an arbitrary program
        // on this host via a local-path remote. Reject outright rather than
        // relying solely on the `--` end-of-options guard below.
        rejectOptionLike("ref", this.#ref);
        rejectOptionLike("remote", this.#remote);
        this.name = `git:${this.#remote}@${this.#ref}`;
    }
    static async open(options) {
        const source = new NativeGitSource(options);
        await source.#ensureRepo();
        return source;
    }
    async revision() {
        await this.#ensureCommit();
        return { kind: "git", remote: this.#remote, ref: this.#ref, commit: this.#commit };
    }
    async stat(path) {
        const p = normalizeRelative(path);
        if (!this.#relevant(p))
            return undefined;
        if (!p)
            return { path: "", kind: "directory", size: 0, mtimeMs: 0 };
        await this.#ensureCommit();
        const { stdout } = await this.#run(["ls-tree", "-z", this.#commit, "--", p], { encoding: "buffer" });
        const entries = parseLsTreeZ(stdout);
        const entry = entries.find((e) => e.name === p) ?? entries[0];
        if (!entry)
            return undefined;
        const kind = entry.type === "tree" ? "directory" : entry.mode === "120000" ? "symlink" : "file";
        let size = 0;
        if (kind === "file") {
            const sizeResult = await this.#run(["cat-file", "-s", entry.objectId]);
            size = Number(String(sizeResult.stdout).trim()) || 0;
        }
        return { path: p, kind, size, mtimeMs: 0, objectId: entry.objectId };
    }
    async listDir(path) {
        const p = normalizeRelative(path);
        if (!this.#relevant(p))
            return [];
        await this.#ensureCommit();
        const treeish = p ? `${this.#commit}:${p}` : this.#commit;
        try {
            const { stdout } = await this.#run(["ls-tree", "-z", treeish], { encoding: "buffer" });
            return parseLsTreeZ(stdout)
                .map((entry) => {
                const full = p ? `${p}/${entry.name}` : entry.name;
                return {
                    path: full,
                    kind: entry.type === "tree" ? "directory" : entry.mode === "120000" ? "symlink" : "file",
                    size: 0,
                    mtimeMs: 0,
                    objectId: entry.objectId,
                };
            })
                .filter((entry) => this.#relevant(entry.path));
        }
        catch (error) {
            if (isMissingTreeish(error))
                return [];
            throw error;
        }
    }
    async readFile(path) {
        const p = normalizeRelative(path);
        if (!this.#relevant(p))
            throw new Error(`Path outside sparse view: ${p}`);
        await this.#ensureCommit();
        const info = await this.stat(p);
        if (!info?.objectId)
            throw new Error(`Git path is not a file: ${p}`);
        if (info.size > this.#maxBlobBytes)
            throw new Error(`Git blob exceeds hydration limit (${info.size} > ${this.#maxBlobBytes}): ${p}`);
        const batch = this.#batch ??= new GitCatFileBatch({ gitDir: this.#gitDir, gitBin: this.#git });
        const object = await batch.read(info.objectId);
        if (object.type !== "blob")
            throw new Error(`Expected blob for ${p}, got ${object.type}`);
        return object.bytes;
    }
    async *listFiles() {
        await this.#ensureCommit();
        const { stdout } = await this.#run(["ls-tree", "-r", "-z", "--name-only", this.#commit], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
        for (const p of stdout.toString("utf8").split("\0")) {
            if (p && this.#relevant(p))
                yield p;
        }
    }
    async close() {
        await this.#batch?.close();
        this.#batch = undefined;
    }
    async #ensureRepo() {
        await mkdir(dirname(this.#gitDir), { recursive: true });
        let exists = true;
        try {
            await access(this.#gitDir);
        }
        catch {
            exists = false;
        }
        if (!exists)
            await this.#runRaw(["init", "--bare", this.#gitDir]);
        try {
            await this.#run(["remote", "get-url", "origin"]);
            await this.#run(["remote", "set-url", "origin", this.#remote]);
        }
        catch {
            await this.#run(["remote", "add", "origin", this.#remote]);
        }
        await this.#run([
            "fetch",
            "--no-tags",
            `--depth=${this.#depth}`,
            `--filter=${this.#filter}`,
            "origin",
            "--",
            this.#ref,
        ], { maxBuffer: 64 * 1024 * 1024 });
        const result = await this.#run(["rev-parse", "FETCH_HEAD"]);
        this.#commit = String(result.stdout).trim();
    }
    async #ensureCommit() {
        if (!this.#commit)
            await this.#ensureRepo();
    }
    #relevant(path) {
        if (this.#sparse.length === 0 || path === "")
            return true;
        return this.#sparse.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`));
    }
    #run(args, options = {}) {
        return this.#runRaw([`--git-dir=${this.#gitDir}`, ...args], options);
    }
    async #runRaw(args, options = {}) {
        const encoding = options.encoding === "buffer" ? "buffer" : "utf8";
        const result = await execFileAsync(this.#git, args, {
            encoding: encoding,
            maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        return result;
    }
}
function rejectOptionLike(field, value) {
    if (value.startsWith("-")) {
        throw new Error(`Invalid git ${field} (must not start with '-'): ${value}`);
    }
}
function isMissingTreeish(error) {
    if (!error || typeof error !== "object")
        return false;
    const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    const text = `${stderr}\n${message}`;
    return /not a valid object name/i.test(text) || /not a tree object/i.test(text) || /path .* does not exist/i.test(text);
}
