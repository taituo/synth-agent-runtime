import type { AgentId, TaskId, WorkspaceId } from "../core/ids.js";
import type { AgentDefinition, AgentMessage, InferenceProfile } from "../core/types.js";
import type { Effect, EffectResult } from "../execution/types.js";
export interface AgentEngineContext {
    agentId: AgentId;
    taskId?: TaskId;
    workspaceId: WorkspaceId;
    definition: AgentDefinition;
    inferenceProfile: InferenceProfile;
    signal: AbortSignal;
    emitOutput(text: string): void;
    emitTool(name: string, phase: "start" | "end", data?: unknown): void;
    executeEffect?(effect: Effect, minFidelity?: number): Promise<EffectResult>;
}
export interface AgentEngine {
    run(messages: readonly AgentMessage[], context: AgentEngineContext): Promise<unknown>;
    steer?(message: AgentMessage): Promise<void> | void;
}
