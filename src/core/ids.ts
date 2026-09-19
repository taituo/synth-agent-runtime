import { randomUUID } from "node:crypto";

export type AgentId = string & { readonly __agentId: unique symbol };
export type TaskId = string & { readonly __taskId: unique symbol };
export type WorkspaceId = string & { readonly __workspaceId: unique symbol };
export type ArtifactId = string & { readonly __artifactId: unique symbol };
export type ProjectId = string & { readonly __projectId: unique symbol };

export const newAgentId = (): AgentId => `agt_${randomUUID()}` as AgentId;
export const newTaskId = (): TaskId => `tsk_${randomUUID()}` as TaskId;
export const newWorkspaceId = (): WorkspaceId => `ws_${randomUUID()}` as WorkspaceId;
export const newArtifactId = (): ArtifactId => `art_${randomUUID()}` as ArtifactId;
export const newProjectId = (): ProjectId => `prj_${randomUUID()}` as ProjectId;
