import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArtifactId, ProjectId, TaskId } from "../core/ids.js";
import type { Artifact, TaskSpec } from "../core/types.js";
import { InMemoryWorldStore } from "./in-memory-world.js";
import type { ArtifactCasResult, ProjectDecision, ProjectProjection, ProjectSpec, TaskCasResult, WorldCasResult, WorldDocument, WorldStore } from "./types.js";

/** Single-process crash-safe world store with serialized mutations and CAS. */
export class JsonFileWorldStore implements WorldStore {
  #chain: Promise<unknown> = Promise.resolve();
  private constructor(private readonly path: string, private readonly memory: InMemoryWorldStore) {}

  static async open(path: string): Promise<JsonFileWorldStore> {
    const memory = new InMemoryWorldStore();
    try { memory.restore(parseDocument(await readFile(path, "utf8"))); }
    catch (error) { if (!isNotFound(error)) throw error; }
    return new JsonFileWorldStore(path, memory);
  }

  async createProject(input: Parameters<InMemoryWorldStore["createProject"]>[0]): Promise<ProjectSpec> {
    return this.mutate(async () => this.memory.createProject(input));
  }
  async putProject(project: ProjectSpec): Promise<void> { await this.mutate(async () => this.memory.putProject(project)); }
  async compareAndSwapProject(project: ProjectSpec, expectedRevision: number): Promise<WorldCasResult> {
    return this.mutate(async () => this.memory.compareAndSwapProject(project, expectedRevision));
  }
  getProject(id: ProjectId) { return this.memory.getProject(id); }
  listProjects() { return this.memory.listProjects(); }
  async putTask(task: TaskSpec): Promise<void> { await this.mutate(async () => this.memory.putTask(task)); }
  async compareAndSwapTask(task: TaskSpec, expectedRevision: number): Promise<TaskCasResult> {
    return this.mutate(async () => this.memory.compareAndSwapTask(task, expectedRevision));
  }
  getTask(id: TaskId) { return this.memory.getTask(id); }
  async putArtifact(artifact: Artifact): Promise<void> { await this.mutate(async () => this.memory.putArtifact(artifact)); }
  async compareAndSwapArtifact(artifact: Artifact, expectedRevision: number): Promise<ArtifactCasResult> {
    return this.mutate(async () => this.memory.compareAndSwapArtifact(artifact, expectedRevision));
  }
  getArtifact(id: ArtifactId) { return this.memory.getArtifact(id); }
  projection(projectId: ProjectId): Promise<ProjectProjection | undefined> { return this.memory.projection(projectId); }
  async attachTask(projectId: ProjectId, task: TaskSpec): Promise<void> { await this.mutate(async () => this.memory.attachTask(projectId, task)); }
  async attachArtifact(projectId: ProjectId, artifact: Artifact): Promise<void> { await this.mutate(async () => this.memory.attachArtifact(projectId, artifact)); }
  async addDecision(projectId: ProjectId, decision: Omit<ProjectDecision, "id" | "createdAt"> & { id?: string; createdAt?: number }): Promise<ProjectDecision> {
    return this.mutate(async () => this.memory.addDecision(projectId, decision));
  }

  async flush(): Promise<void> { await this.publish(); }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(async () => { const value = await operation(); await this.publish(); return value; });
    this.#chain = next.catch(() => undefined);
    return next;
  }

  private async publish(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, stringifyDocument(this.memory.dump()), "utf8");
    await rename(tmp, this.path);
  }
}

function stringifyDocument(document: WorldDocument): string {
  return JSON.stringify(document, (_key, value) => value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("base64") } : value, 2) + "\n";
}
function parseDocument(text: string): WorldDocument {
  const parsed = JSON.parse(text, (_key, value) => value && typeof value === "object" && Object.keys(value).length === 1 && typeof value.$bytes === "string" ? new Uint8Array(Buffer.from(value.$bytes, "base64")) : value) as WorldDocument;
  return { ...parsed, projects: (parsed.projects ?? []).map((project) => ({ ...project, revision: project.revision ?? 0 })) };
}
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
