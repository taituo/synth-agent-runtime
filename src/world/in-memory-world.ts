import { newProjectId, type ArtifactId, type ProjectId, type TaskId } from "../core/ids.js";
import type { Artifact, TaskSpec } from "../core/types.js";
import type { ProjectDecision, ProjectProjection, ProjectSpec, WorldCasResult, WorldDocument, WorldStore } from "./types.js";

function clone<T>(value: T): T { return structuredClone(value); }
function normalizeProject(project: ProjectSpec | (Omit<ProjectSpec, "revision"> & { revision?: number })): ProjectSpec {
  return { ...project, revision: project.revision ?? 0 } as ProjectSpec;
}

export class InMemoryWorldStore implements WorldStore {
  readonly #projects = new Map<ProjectId, ProjectSpec>();
  readonly #tasks = new Map<TaskId, TaskSpec>();
  readonly #artifacts = new Map<ArtifactId, Artifact>();

  async createProject(input: {
    id?: ProjectId;
    name: string;
    objective: string;
    constraints?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<ProjectSpec> {
    const now = Date.now();
    const project: ProjectSpec = {
      id: input.id ?? newProjectId(),
      revision: 0,
      name: input.name,
      objective: input.objective,
      createdAt: now,
      updatedAt: now,
      constraints: (input.constraints ?? []).map((text, index) => ({ id: `constraint-${index + 1}`, text, source: "human", createdAt: now, active: true })),
      decisions: [],
      taskIds: [],
      artifactIds: [],
      metadata: input.metadata ?? {},
    };
    await this.putProject(project);
    return clone(project);
  }

  async putProject(project: ProjectSpec): Promise<void> {
    const next = normalizeProject(project);
    const existing = this.#projects.get(project.id);
    if (existing && next.revision <= existing.revision) throw new Error(`WORLD_PUT_REQUIRES_NEWER_REVISION:${project.id}:${existing.revision}`);
    this.#projects.set(project.id, clone(next));
  }

  async compareAndSwapProject(project: ProjectSpec, expectedRevision: number): Promise<WorldCasResult> {
    const existing = this.#projects.get(project.id);
    if (!existing) throw new Error(`Unknown project ${project.id}`);
    if (existing.revision !== expectedRevision) return { swapped: false, project: clone(existing) };
    const next = { ...clone(project), revision: expectedRevision + 1, updatedAt: Date.now() };
    this.#projects.set(project.id, next);
    return { swapped: true, project: clone(next) };
  }

  async getProject(id: ProjectId): Promise<ProjectSpec | undefined> { const value = this.#projects.get(id); return value ? clone(value) : undefined; }
  async listProjects(): Promise<ProjectSpec[]> { return [...this.#projects.values()].map(clone); }

  dump(): WorldDocument { return { projects: [...this.#projects.values()].map(clone), tasks: [...this.#tasks.values()].map(clone), artifacts: [...this.#artifacts.values()].map(clone) }; }

  restore(document: WorldDocument): void {
    this.#projects.clear(); this.#tasks.clear(); this.#artifacts.clear();
    for (const project of document.projects) this.#projects.set(project.id, clone(normalizeProject(project)));
    for (const task of document.tasks) this.#tasks.set(task.id, clone(task));
    for (const artifact of document.artifacts) this.#artifacts.set(artifact.id, clone(artifact));
  }

  async putTask(task: TaskSpec): Promise<void> { this.#tasks.set(task.id, clone(task)); }
  async getTask(id: TaskId): Promise<TaskSpec | undefined> { const value = this.#tasks.get(id); return value ? clone(value) : undefined; }
  async putArtifact(artifact: Artifact): Promise<void> { this.#artifacts.set(artifact.id, clone(artifact)); }
  async getArtifact(id: ArtifactId): Promise<Artifact | undefined> { const value = this.#artifacts.get(id); return value ? clone(value) : undefined; }

  async attachTask(projectId: ProjectId, task: TaskSpec): Promise<void> {
    await this.putTask(task);
    await this.updateProject(projectId, (project) => { if (!project.taskIds.includes(task.id)) project.taskIds.push(task.id); });
  }

  async attachArtifact(projectId: ProjectId, artifact: Artifact): Promise<void> {
    await this.putArtifact(artifact);
    await this.updateProject(projectId, (project) => { if (!project.artifactIds.includes(artifact.id)) project.artifactIds.push(artifact.id); });
  }

  async addDecision(projectId: ProjectId, decision: Omit<ProjectDecision, "id" | "createdAt"> & { id?: string; createdAt?: number }): Promise<ProjectDecision> {
    let created!: ProjectDecision;
    await this.updateProject(projectId, (project) => {
      created = { ...decision, id: decision.id ?? `decision-${project.decisions.length + 1}`, createdAt: decision.createdAt ?? Date.now() };
      project.decisions.push(created);
    });
    return clone(created);
  }

  async projection(projectId: ProjectId): Promise<ProjectProjection | undefined> {
    const project = await this.getProject(projectId); if (!project) return undefined;
    const tasks = (await Promise.all(project.taskIds.map((id) => this.getTask(id)))).filter((v): v is TaskSpec => Boolean(v));
    const artifacts = (await Promise.all(project.artifactIds.map((id) => this.getArtifact(id)))).filter((v): v is Artifact => Boolean(v));
    const activeConstraints = project.constraints.filter((c) => c.active).map((c) => `- ${c.text}`);
    const acceptedDecisions = project.decisions.filter((d) => d.status === "accepted").map((d) => `- ${d.title}: ${d.rationale}`);
    const taskLines = tasks.map((task) => `- [${task.status}] ${task.title}: ${task.objective}`);
    const contextText = [`# Project: ${project.name}`, project.objective, activeConstraints.length ? `\n## Constraints\n${activeConstraints.join("\n")}` : "", acceptedDecisions.length ? `\n## Accepted decisions\n${acceptedDecisions.join("\n")}` : "", taskLines.length ? `\n## Tasks\n${taskLines.join("\n")}` : ""].filter(Boolean).join("\n");
    return { project, tasks, artifacts, contextText };
  }

  private async updateProject(id: ProjectId, mutate: (project: ProjectSpec) => void): Promise<ProjectSpec> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await this.requireProject(id);
      const next = clone(current); mutate(next);
      const result = await this.compareAndSwapProject(next, current.revision);
      if (result.swapped) return result.project;
    }
    throw new Error(`WORLD_CAS_RETRY_EXHAUSTED:${id}`);
  }

  private async requireProject(id: ProjectId): Promise<ProjectSpec> { const project = await this.getProject(id); if (!project) throw new Error(`Unknown project ${id}`); return project; }
}
