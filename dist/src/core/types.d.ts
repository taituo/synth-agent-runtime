import type { AgentId, ArtifactId, TaskId, WorkspaceId } from "./ids.js";
import type { ExecutionPolicy } from "../execution/resource-class.js";
export type AgentState = "idle" | "thinking" | "waiting_for_tool" | "waiting_for_agent" | "waiting_for_human" | "waiting_for_resource" | "sleeping" | "blocked" | "completed" | "failed" | "cancelled";
export type RelationKind = "supervises" | "delegates_to" | "consults" | "reviews" | "reports_to" | "shares_resource";
export interface Relation {
    from: AgentId;
    to: AgentId;
    kind: RelationKind;
    metadata?: Record<string, unknown>;
}
export interface InferenceProfile {
    id: string;
    model?: string;
    priority?: "interactive" | "normal" | "background";
    budgetClass?: "cheap" | "standard" | "premium";
    requiredCapabilities?: string[];
}
export interface TaskSpec {
    id: TaskId;
    /** Monotonic per-record revision for compare-and-swap updates (default 0). */
    revision?: number;
    title: string;
    objective: string;
    constraints?: string[];
    dependencies?: TaskId[];
    owner?: AgentId;
    contributors?: AgentId[];
    status: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
    metadata?: Record<string, unknown>;
}
export interface Artifact {
    id: ArtifactId;
    /** Monotonic per-record revision for compare-and-swap updates (default 0). */
    revision?: number;
    type: "workspace-diff" | "patch" | "report" | "build" | "custom";
    taskId?: TaskId;
    workspaceId?: WorkspaceId;
    createdAt: number;
    data: unknown;
    metadata?: Record<string, unknown>;
}
export interface AgentDefinition {
    id: string;
    systemPrompt?: string;
    capabilities?: string[];
    inferenceProfile: InferenceProfile;
    executionPolicy?: ExecutionPolicy;
}
export interface AgentSnapshot {
    id: AgentId;
    definitionId: string;
    taskId?: TaskId;
    workspaceId: WorkspaceId;
    state: AgentState;
    createdAt: number;
    updatedAt: number;
    mailbox: AgentMessage[];
    metadata: Record<string, unknown>;
}
export interface AgentMessage {
    id: string;
    role: "human" | "agent" | "system";
    text: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
}
export type RuntimeEvent = {
    type: "agent.created";
    agent: AgentSnapshot;
} | {
    type: "agent.recovered";
    agent: AgentSnapshot;
    previousState: AgentState;
    at: number;
} | {
    type: "agent.state";
    agentId: AgentId;
    from: AgentState;
    to: AgentState;
    at: number;
} | {
    type: "agent.message";
    agentId: AgentId;
    message: AgentMessage;
} | {
    type: "agent.output";
    agentId: AgentId;
    text: string;
    at: number;
} | {
    type: "agent.tool";
    agentId: AgentId;
    name: string;
    phase: "start" | "end";
    at: number;
    data?: unknown;
} | {
    type: "agent.completed";
    agentId: AgentId;
    result?: unknown;
    at: number;
} | {
    type: "agent.failed";
    agentId: AgentId;
    error: string;
    at: number;
} | {
    type: "task.updated";
    task: TaskSpec;
} | {
    type: "relation.added";
    relation: Relation;
} | {
    type: "artifact.created";
    artifact: Artifact;
};
