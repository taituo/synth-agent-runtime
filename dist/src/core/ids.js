import { randomUUID } from "node:crypto";
export const newAgentId = () => `agt_${randomUUID()}`;
export const newTaskId = () => `tsk_${randomUUID()}`;
export const newWorkspaceId = () => `ws_${randomUUID()}`;
export const newArtifactId = () => `art_${randomUUID()}`;
export const newProjectId = () => `prj_${randomUUID()}`;
