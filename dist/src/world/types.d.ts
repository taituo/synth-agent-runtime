import type { AgentId, ArtifactId, ProjectId, TaskId } from "../core/ids.js";
import type { Artifact, TaskSpec } from "../core/types.js";
export interface ProjectConstraint {
    id: string;
    text: string;
    source?: "human" | "agent" | "system";
    createdAt: number;
    active: boolean;
}
export interface ProjectDecision {
    id: string;
    title: string;
    rationale: string;
    status: "proposed" | "accepted" | "rejected" | "superseded";
    createdAt: number;
    createdBy?: AgentId;
    supersedes?: string;
    metadata?: Record<string, unknown>;
}
export interface ProjectSpec {
    id: ProjectId;
    /** Monotonic canonical-world revision used for compare-and-swap updates. */
    revision: number;
    name: string;
    objective: string;
    createdAt: number;
    updatedAt: number;
    constraints: ProjectConstraint[];
    decisions: ProjectDecision[];
    taskIds: TaskId[];
    artifactIds: ArtifactId[];
    metadata: Record<string, unknown>;
}
export interface ProjectProjection {
    project: ProjectSpec;
    tasks: TaskSpec[];
    artifacts: Artifact[];
    /** Compact text intended for agent-context construction, not canonical storage. */
    contextText: string;
}
export interface WorldDocument {
    projects: ProjectSpec[];
    tasks: TaskSpec[];
    artifacts: Artifact[];
}
export interface WorldCasResult {
    swapped: boolean;
    project: ProjectSpec;
}
export interface WorldStore {
    putProject(project: ProjectSpec): Promise<void>;
    compareAndSwapProject(project: ProjectSpec, expectedRevision: number): Promise<WorldCasResult>;
    getProject(id: ProjectId): Promise<ProjectSpec | undefined>;
    listProjects(): Promise<ProjectSpec[]>;
    putTask(task: TaskSpec): Promise<void>;
    getTask(id: TaskId): Promise<TaskSpec | undefined>;
    putArtifact(artifact: Artifact): Promise<void>;
    getArtifact(id: ArtifactId): Promise<Artifact | undefined>;
    projection(projectId: ProjectId): Promise<ProjectProjection | undefined>;
}
