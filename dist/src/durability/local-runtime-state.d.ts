import type { WorkspaceId } from "../core/ids.js";
import { type DurableCommandRecord, DurableEffectRecord, DurableTurnRecord, DurableWorkspaceCheckpoint, RuntimeStateStore, TurnStatus } from "./runtime-state.js";
export declare class LocalRuntimeStateStore implements RuntimeStateStore {
    #private;
    putCommand(record: DurableCommandRecord): Promise<void>;
    getCommand(id: string): Promise<DurableCommandRecord | undefined>;
    claimCommand(record: DurableCommandRecord): Promise<{
        claimed: boolean;
        record: DurableCommandRecord;
    }>;
    putWorkspaceCheckpoint(checkpoint: DurableWorkspaceCheckpoint): Promise<void>;
    getWorkspaceCheckpoint(workspaceId: WorkspaceId): Promise<DurableWorkspaceCheckpoint | undefined>;
    putTurn(record: DurableTurnRecord): Promise<void>;
    getTurn(id: string): Promise<DurableTurnRecord | undefined>;
    listTurns(status?: TurnStatus): Promise<DurableTurnRecord[]>;
    putEffect(record: DurableEffectRecord): Promise<void>;
    getEffect(id: string): Promise<DurableEffectRecord | undefined>;
    claimEffect(record: DurableEffectRecord): Promise<{
        claimed: boolean;
        record: DurableEffectRecord;
    }>;
}
