export type AgentId = string & {
    readonly __agentId: unique symbol;
};
export type TaskId = string & {
    readonly __taskId: unique symbol;
};
export type WorkspaceId = string & {
    readonly __workspaceId: unique symbol;
};
export type ArtifactId = string & {
    readonly __artifactId: unique symbol;
};
export type ProjectId = string & {
    readonly __projectId: unique symbol;
};
export declare const newAgentId: () => AgentId;
export declare const newTaskId: () => TaskId;
export declare const newWorkspaceId: () => WorkspaceId;
export declare const newArtifactId: () => ArtifactId;
export declare const newProjectId: () => ProjectId;
