import type { AgentId, ArtifactId, TaskId, WorkspaceId } from "./ids.js";
import type { ExecutionPolicy } from "../execution/resource-class.js";
import type { ArtifactRef } from "../execution/types.js";

export type AgentState =
  | "idle"
  | "thinking"
  | "waiting_for_tool"
  | "waiting_for_agent"
  | "waiting_for_human"
  | "waiting_for_resource"
  | "sleeping"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

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

/**
 * A bounded inline copy of small artifact content. The `ref` is always the
 * source of truth; this is an explicit escape hatch under the same
 * `MAX_INLINE_SNAPSHOT_BYTES` ceiling as the snapshot path, so small content
 * does not force a store read. Over the ceiling it is not produced at all.
 */
export interface InlineArtifact {
  mediaType: string;
  /** Base64 of the exact bytes; `size` is the decoded length. */
  dataBase64: string;
  size: number;
}

export interface Artifact {
  id: ArtifactId;
  /** Monotonic per-record revision for compare-and-swap updates (default 0). */
  revision?: number;
  type: "workspace-diff" | "patch" | "report" | "build" | "custom";
  taskId?: TaskId;
  workspaceId?: WorkspaceId;
  createdAt: number;
  /**
   * A reference to the content, never the bytes: the same rule the rest of the
   * system follows. The content lives in the blob store and the digest resolves
   * to exactly those bytes. (This replaced an inline `data: unknown` field,
   * which let the blackboard carry content the rule forbids.)
   */
  ref: ArtifactRef;
  /** Opt-in, bounded inline copy. Never larger than `MAX_INLINE_SNAPSHOT_BYTES`. */
  inline?: InlineArtifact;
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

export type RuntimeEvent =
  | { type: "agent.created"; agent: AgentSnapshot }
  | { type: "agent.recovered"; agent: AgentSnapshot; previousState: AgentState; at: number }
  | { type: "agent.state"; agentId: AgentId; from: AgentState; to: AgentState; at: number }
  | { type: "agent.message"; agentId: AgentId; message: AgentMessage }
  | { type: "agent.output"; agentId: AgentId; text: string; at: number }
  | { type: "agent.tool"; agentId: AgentId; name: string; phase: "start" | "end"; at: number; data?: unknown }
  | { type: "agent.completed"; agentId: AgentId; result?: unknown; at: number }
  | { type: "agent.failed"; agentId: AgentId; error: string; at: number }
  | { type: "task.updated"; task: TaskSpec }
  | { type: "relation.added"; relation: Relation }
  | { type: "artifact.created"; artifact: Artifact };
