import type { ArtifactId, ProjectId, TaskId } from "../core/ids.js";
import type { Artifact, TaskSpec } from "../core/types.js";
import { InMemoryWorldStore } from "./in-memory-world.js";
import type { ArtifactCasResult, ProjectDecision, ProjectProjection, ProjectSpec, TaskCasResult, WorldCasResult, WorldStore } from "./types.js";
/** Single-process crash-safe world store with serialized mutations and CAS. */
export declare class JsonFileWorldStore implements WorldStore {
    #private;
    private readonly path;
    private readonly memory;
    private constructor();
    static open(path: string): Promise<JsonFileWorldStore>;
    createProject(input: Parameters<InMemoryWorldStore["createProject"]>[0]): Promise<ProjectSpec>;
    putProject(project: ProjectSpec): Promise<void>;
    compareAndSwapProject(project: ProjectSpec, expectedRevision: number): Promise<WorldCasResult>;
    getProject(id: ProjectId): Promise<ProjectSpec | undefined>;
    listProjects(): Promise<ProjectSpec[]>;
    putTask(task: TaskSpec): Promise<void>;
    compareAndSwapTask(task: TaskSpec, expectedRevision: number): Promise<TaskCasResult>;
    getTask(id: TaskId): Promise<TaskSpec | undefined>;
    putArtifact(artifact: Artifact): Promise<void>;
    compareAndSwapArtifact(artifact: Artifact, expectedRevision: number): Promise<ArtifactCasResult>;
    getArtifact(id: ArtifactId): Promise<Artifact | undefined>;
    projection(projectId: ProjectId): Promise<ProjectProjection | undefined>;
    attachTask(projectId: ProjectId, task: TaskSpec): Promise<void>;
    attachArtifact(projectId: ProjectId, artifact: Artifact): Promise<void>;
    addDecision(projectId: ProjectId, decision: Omit<ProjectDecision, "id" | "createdAt"> & {
        id?: string;
        createdAt?: number;
    }): Promise<ProjectDecision>;
    flush(): Promise<void>;
    private mutate;
    private publish;
}
