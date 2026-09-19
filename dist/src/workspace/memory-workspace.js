import { newArtifactId, newWorkspaceId } from "../core/ids.js";
import { normalizeRelative } from "./source.js";
const decoder = new TextDecoder();
const encoder = new TextEncoder();
function equalBytes(a, b) {
    if (a === undefined || b === undefined)
        return a === b;
    if (a.byteLength !== b.byteLength)
        return false;
    for (let i = 0; i < a.byteLength; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
export class MemoryWorkspace {
    id;
    source;
    #overlay = new Map();
    #deleted = new Set();
    #changed = new Set();
    constructor(options = {}) {
        this.id = options.id ?? newWorkspaceId();
        this.source = options.source;
    }
    async read(path) {
        const p = normalizeRelative(path);
        if (this.#deleted.has(p))
            return undefined;
        const over = this.#overlay.get(p);
        if (over)
            return over.slice();
        if (!this.source)
            return undefined;
        const info = await this.source.stat(p);
        if (!info || info.kind !== "file")
            return undefined;
        return this.source.readFile(p);
    }
    async readText(path) {
        const bytes = await this.read(path);
        return bytes ? decoder.decode(bytes) : undefined;
    }
    write(path, content) {
        const p = normalizeRelative(path);
        if (!p)
            throw new Error("Cannot write workspace root");
        const bytes = typeof content === "string" ? encoder.encode(content) : content.slice();
        this.#overlay.set(p, bytes);
        this.#deleted.delete(p);
        this.#changed.add(p);
    }
    delete(path) {
        const p = normalizeRelative(path);
        if (!p)
            throw new Error("Cannot delete workspace root");
        this.#overlay.delete(p);
        this.#deleted.add(p);
        this.#changed.add(p);
    }
    async listDir(path = "") {
        const dir = normalizeRelative(path);
        const names = new Set();
        if (this.source) {
            for (const entry of await this.source.listDir(dir)) {
                const rel = entry.path.slice(dir ? dir.length + 1 : 0);
                const name = rel.split("/")[0];
                if (name)
                    names.add(name);
            }
        }
        for (const p of this.#overlay.keys()) {
            if (dir && !p.startsWith(`${dir}/`))
                continue;
            const rel = dir ? p.slice(dir.length + 1) : p;
            const name = rel.split("/")[0];
            if (name)
                names.add(name);
        }
        for (const p of this.#deleted) {
            const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
            if (parent === dir)
                names.delete(p.slice(parent ? parent.length + 1 : 0));
        }
        return [...names].sort();
    }
    changedPaths() {
        return [...this.#changed].sort();
    }
    async snapshot() {
        return {
            id: this.id,
            revision: await this.source?.revision(),
            overlay: new Map([...this.#overlay].map(([k, v]) => [k, v.slice()])),
            deleted: new Set(this.#deleted),
            changed: new Set(this.#changed),
        };
    }
    restore(snapshot) {
        if (snapshot.id !== this.id) {
            throw new Error(`Workspace snapshot ${snapshot.id} does not belong to ${this.id}`);
        }
        this.#overlay = new Map([...snapshot.overlay].map(([k, v]) => [k, v.slice()]));
        this.#deleted = new Set(snapshot.deleted);
        this.#changed = new Set(snapshot.changed);
    }
    fork() {
        const child = new MemoryWorkspace({ source: this.source });
        child.#overlay = new Map([...this.#overlay].map(([k, v]) => [k, v.slice()]));
        child.#deleted = new Set(this.#deleted);
        child.#changed = new Set(this.#changed);
        return child;
    }
    async diff() {
        const changes = [];
        for (const path of this.changedPaths()) {
            const current = await this.read(path);
            let base;
            if (this.source) {
                const info = await this.source.stat(path);
                if (info?.kind === "file")
                    base = await this.source.readFile(path);
            }
            if (equalBytes(base, current))
                continue;
            if (!current)
                changes.push({ path, kind: "delete" });
            else if (!base)
                changes.push({ path, kind: "add", content: current });
            else
                changes.push({ path, kind: "modify", content: current });
        }
        return changes;
    }
    async exportArtifact() {
        return {
            id: newArtifactId(),
            type: "workspace-diff",
            workspaceId: this.id,
            createdAt: Date.now(),
            data: {
                revision: await this.source?.revision(),
                changes: await this.diff(),
            },
        };
    }
}
