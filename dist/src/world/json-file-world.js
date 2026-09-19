import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { InMemoryWorldStore } from "./in-memory-world.js";
/** Single-process crash-safe world store with serialized mutations and CAS. */
export class JsonFileWorldStore {
    path;
    memory;
    #chain = Promise.resolve();
    constructor(path, memory) {
        this.path = path;
        this.memory = memory;
    }
    static async open(path) {
        const memory = new InMemoryWorldStore();
        try {
            memory.restore(parseDocument(await readFile(path, "utf8")));
        }
        catch (error) {
            if (!isNotFound(error))
                throw error;
        }
        return new JsonFileWorldStore(path, memory);
    }
    async createProject(input) {
        return this.mutate(async () => this.memory.createProject(input));
    }
    async putProject(project) { await this.mutate(async () => this.memory.putProject(project)); }
    async compareAndSwapProject(project, expectedRevision) {
        return this.mutate(async () => this.memory.compareAndSwapProject(project, expectedRevision));
    }
    getProject(id) { return this.memory.getProject(id); }
    listProjects() { return this.memory.listProjects(); }
    async putTask(task) { await this.mutate(async () => this.memory.putTask(task)); }
    async compareAndSwapTask(task, expectedRevision) {
        return this.mutate(async () => this.memory.compareAndSwapTask(task, expectedRevision));
    }
    getTask(id) { return this.memory.getTask(id); }
    async putArtifact(artifact) { await this.mutate(async () => this.memory.putArtifact(artifact)); }
    async compareAndSwapArtifact(artifact, expectedRevision) {
        return this.mutate(async () => this.memory.compareAndSwapArtifact(artifact, expectedRevision));
    }
    getArtifact(id) { return this.memory.getArtifact(id); }
    projection(projectId) { return this.memory.projection(projectId); }
    async attachTask(projectId, task) { await this.mutate(async () => this.memory.attachTask(projectId, task)); }
    async attachArtifact(projectId, artifact) { await this.mutate(async () => this.memory.attachArtifact(projectId, artifact)); }
    async addDecision(projectId, decision) {
        return this.mutate(async () => this.memory.addDecision(projectId, decision));
    }
    async flush() { await this.publish(); }
    async mutate(operation) {
        const next = this.#chain.then(async () => { const value = await operation(); await this.publish(); return value; });
        this.#chain = next.catch(() => undefined);
        return next;
    }
    async publish() {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await writeFile(tmp, stringifyDocument(this.memory.dump()), "utf8");
        await rename(tmp, this.path);
    }
}
function stringifyDocument(document) {
    return JSON.stringify(document, (_key, value) => value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("base64") } : value, 2) + "\n";
}
function parseDocument(text) {
    const parsed = JSON.parse(text, (_key, value) => value && typeof value === "object" && Object.keys(value).length === 1 && typeof value.$bytes === "string" ? new Uint8Array(Buffer.from(value.$bytes, "base64")) : value);
    return { ...parsed, projects: (parsed.projects ?? []).map((project) => ({ ...project, revision: project.revision ?? 0 })) };
}
function isNotFound(error) { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
