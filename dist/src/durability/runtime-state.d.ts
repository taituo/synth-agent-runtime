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
export declare function canReplaceCommand(existing: DurableCommandRecord | undefined, next: DurableCommandRecord): boolean;
/**
 * Prevent a resolved effect receipt from being regressed by a stale or
 * uncertain writer.
 *
 * Effects carry no fencing token (unlike commands), so the only ordering
 * guarantee available is terminal-status monotonicity: a committed receipt can
 * only be replaced by another committed receipt, and a failed receipt cannot
 * be regressed to started. Without this, a slow reconciler that returns
 * `pending` can overwrite a concurrent `committed` resolution, silently
 * discarding the effect result and leaving the broker to report
 * `EFFECT_OUTCOME_UNCERTAIN` for an effect that already succeeded.
 */
export declare function canReplaceEffect(existing: DurableEffectRecord | undefined, next: DurableEffectRecord): boolean;
