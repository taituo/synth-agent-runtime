import type { AgentId, WorkspaceId } from "../core/ids.js";
import type { SerializedWorkspaceSnapshot } from "../workspace/snapshot-codec.js";

export type CommandStatus = "started" | "committed" | "failed";
export type TurnStatus = "started" | "committed" | "rolled_back" | "failed";
export type EffectStatus = "started" | "committed" | "failed";

export interface DurableCommandRecord {
  id: string;
  status: CommandStatus;
  startedAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
  ownerId?: string;
  fencingToken?: number;
  leaseExpiresAt?: number;
  reconciliationRequired?: boolean;
}

export interface DurableEffectRecord {
  id: string;
  status: EffectStatus;
  kind: string;
  startedAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

export interface DurableWorkspaceCheckpoint {
  workspaceId: WorkspaceId;
  snapshot: SerializedWorkspaceSnapshot;
  reason: string;
  createdAt: number;
}

export interface DurableTurnRecord {
  id: string;
  agentId?: AgentId;
  workspaceId: WorkspaceId;
  attemptId: string;
  status: TurnStatus;
  startedAt: number;
  updatedAt: number;
  base: SerializedWorkspaceSnapshot;
  semanticExposed: boolean;
  bufferedOutputCount: number;
  stagedEffectIds: string[];
  error?: string;
}

export interface ClaimResult<T> {
  claimed: boolean;
  record: T;
}

export interface RuntimeStateStore {
  putCommand(record: DurableCommandRecord): Promise<void>;
  getCommand(id: string): Promise<DurableCommandRecord | undefined>;
  /** Optional atomic claim. Multi-process stores should implement this. */
  claimCommand?(record: DurableCommandRecord): Promise<ClaimResult<DurableCommandRecord>>;

  putWorkspaceCheckpoint(checkpoint: DurableWorkspaceCheckpoint): Promise<void>;
  getWorkspaceCheckpoint(workspaceId: WorkspaceId): Promise<DurableWorkspaceCheckpoint | undefined>;

  putTurn(record: DurableTurnRecord): Promise<void>;
  getTurn(id: string): Promise<DurableTurnRecord | undefined>;
  listTurns(status?: TurnStatus): Promise<DurableTurnRecord[]>;

  putEffect(record: DurableEffectRecord): Promise<void>;
  getEffect(id: string): Promise<DurableEffectRecord | undefined>;
  /** Optional atomic claim. A pre-existing failed/started effect is never reclaimed. */
  claimEffect?(record: DurableEffectRecord): Promise<ClaimResult<DurableEffectRecord>>;
}

/** Prevent stale lease generations or non-terminal writes from regressing committed commands. */
export function canReplaceCommand(existing: DurableCommandRecord | undefined, next: DurableCommandRecord): boolean {
  if (!existing) return true;
  const oldFence = existing.fencingToken ?? 0;
  const newFence = next.fencingToken ?? 0;
  if (newFence < oldFence) return false;
  if (existing.status === "committed" && next.status !== "committed") return false;
  return true;
}
