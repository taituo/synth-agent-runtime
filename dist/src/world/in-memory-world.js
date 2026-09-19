import { newProjectId } from "../core/ids.js";
function clone(value) { return structuredClone(value); }
function normalizeProject(project) {
    return { ...project, revision: project.revision ?? 0 };
}
export class InMemoryWorldStore {
    #projects = new Map();
    #tasks = new Map();
    #artifacts = new Map();
    async createProject(input) {
        const now = Date.now();
        const project = {
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
    async putProject(project) {
        const next = normalizeProject(project);
        const existing = this.#projects.get(project.id);
        if (existing && next.revision <= existing.revision)
            throw new Error(`WORLD_PUT_REQUIRES_NEWER_REVISION:${project.id}:${existing.revision}`);
        this.#projects.set(project.id, clone(next));
    }
    async compareAndSwapProject(project, expectedRevision) {
        const existing = this.#projects.get(project.id);
        if (!existing)
            throw new Error(`Unknown project ${project.id}`);
        if (existing.revision !== expectedRevision)
            return { swapped: false, project: clone(existing) };
        const next = { ...clone(project), revision: expectedRevision + 1, updatedAt: Date.now() };
        this.#projects.set(project.id, next);
        return { swapped: true, project: clone(next) };
    }
    async getProject(id) { const value = this.#projects.get(id); return value ? clone(value) : undefined; }
    async listProjects() { return [...this.#projects.values()].map(clone); }
    dump() { return { projects: [...this.#projects.values()].map(clone), tasks: [...this.#tasks.values()].map(clone), artifacts: [...this.#artifacts.values()].map(clone) }; }
    restore(document) {
        this.#projects.clear();
        this.#tasks.clear();
        this.#artifacts.clear();
        for (const project of document.projects)
            this.#projects.set(project.id, clone(normalizeProject(project)));
        for (const task of document.tasks)
            this.#tasks.set(task.id, clone(task));
        for (const artifact of document.artifacts)
            this.#artifacts.set(artifact.id, clone(artifact));
    }
    async putTask(task) { this.#tasks.set(task.id, clone(task)); }
    async compareAndSwapTask(task, expectedRevision) {
        const existing = this.#tasks.get(task.id);
        if (!existing)
            throw new Error(`Unknown task ${task.id}`);
        if ((existing.revision ?? 0) !== expectedRevision)
            return { swapped: false, task: clone(existing) };
        const next = { ...clone(task), revision: expectedRevision + 1 };
        this.#tasks.set(task.id, next);
        return { swapped: true, task: clone(next) };
    }
    async getTask(id) { const value = this.#tasks.get(id); return value ? clone(value) : undefined; }
    async putArtifact(artifact) { this.#artifacts.set(artifact.id, clone(artifact)); }
    async compareAndSwapArtifact(artifact, expectedRevision) {
        const existing = this.#artifacts.get(artifact.id);
        if (!existing)
            throw new Error(`Unknown artifact ${artifact.id}`);
        if ((existing.revision ?? 0) !== expectedRevision)
            return { swapped: false, artifact: clone(existing) };
        const next = { ...clone(artifact), revision: expectedRevision + 1 };
        this.#artifacts.set(artifact.id, next);
        return { swapped: true, artifact: clone(next) };
    }
    async getArtifact(id) { const value = this.#artifacts.get(id); return value ? clone(value) : undefined; }
    async attachTask(projectId, task) {
        await this.putTask(task);
        await this.updateProject(projectId, (project) => { if (!project.taskIds.includes(task.id))
            project.taskIds.push(task.id); });
    }
    async attachArtifact(projectId, artifact) {
        await this.putArtifact(artifact);
        await this.updateProject(projectId, (project) => { if (!project.artifactIds.includes(artifact.id))
            project.artifactIds.push(artifact.id); });
    }
    async addDecision(projectId, decision) {
        let created;
        await this.updateProject(projectId, (project) => {
            created = { ...decision, id: decision.id ?? `decision-${project.decisions.length + 1}`, createdAt: decision.createdAt ?? Date.now() };
            project.decisions.push(created);
        });
        return clone(created);
    }
    async projection(projectId) {
        const project = await this.getProject(projectId);
        if (!project)
            return undefined;
        const tasks = (await Promise.all(project.taskIds.map((id) => this.getTask(id)))).filter((v) => Boolean(v));
        const artifacts = (await Promise.all(project.artifactIds.map((id) => this.getArtifact(id)))).filter((v) => Boolean(v));
        const activeConstraints = project.constraints.filter((c) => c.active).map((c) => `- ${c.text}`);
        const acceptedDecisions = project.decisions.filter((d) => d.status === "accepted").map((d) => `- ${d.title}: ${d.rationale}`);
        const taskLines = tasks.map((task) => `- [${task.status}] ${task.title}: ${task.objective}`);
        const contextText = [`# Project: ${project.name}`, project.objective, activeConstraints.length ? `\n## Constraints\n${activeConstraints.join("\n")}` : "", acceptedDecisions.length ? `\n## Accepted decisions\n${acceptedDecisions.join("\n")}` : "", taskLines.length ? `\n## Tasks\n${taskLines.join("\n")}` : ""].filter(Boolean).join("\n");
        return { project, tasks, artifacts, contextText };
    }
    async updateProject(id, mutate) {
        for (let attempt = 0; attempt < 32; attempt++) {
            const current = await this.requireProject(id);
            const next = clone(current);
            mutate(next);
            const result = await this.compareAndSwapProject(next, current.revision);
            if (result.swapped)
                return result.project;
        }
        throw new Error(`WORLD_CAS_RETRY_EXHAUSTED:${id}`);
    }
    async requireProject(id) { const project = await this.getProject(id); if (!project)
        throw new Error(`Unknown project ${id}`); return project; }
}
