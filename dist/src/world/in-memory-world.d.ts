import { type ArtifactId, type ProjectId, type TaskId } from "../core/ids.js";
import type { Artifact, TaskSpec } from "../core/types.js";
import type { ProjectDecision, ProjectProjection, ProjectSpec, WorldCasResult, WorldDocument, WorldStore } from "./types.js";
export declare class InMemoryWorldStore implements WorldStore {
    #private;
    createProject(input: {
        id?: ProjectId;
        name: string;
        objective: string;
        constraints?: string[];
        metadata?: Record<string, unknown>;
    }): Promise<ProjectSpec>;
    putProject(project: ProjectSpec): Promise<void>;
    compareAndSwapProject(project: ProjectSpec, expectedRevision: number): Promise<WorldCasResult>;
    getProject(id: ProjectId): Promise<ProjectSpec | undefined>;
    listProjects(): Promise<ProjectSpec[]>;
    dump(): WorldDocument;
    restore(document: WorldDocument): void;
    putTask(task: TaskSpec): Promise<void>;
    getTask(id: TaskId): Promise<TaskSpec | undefined>;
    putArtifact(artifact: Artifact): Promise<void>;
    getArtifact(id: ArtifactId): Promise<Artifact | undefined>;
    attachTask(projectId: ProjectId, task: TaskSpec): Promise<void>;
    attachArtifact(projectId: ProjectId, artifact: Artifact): Promise<void>;
    addDecision(projectId: ProjectId, decision: Omit<ProjectDecision, "id" | "createdAt"> & {
        id?: string;
        createdAt?: number;
    }): Promise<ProjectDecision>;
    projection(projectId: ProjectId): Promise<ProjectProjection | undefined>;
    private updateProject;
    private requireProject;
}
