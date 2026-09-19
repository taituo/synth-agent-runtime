import type { WorkspaceId } from "../core/ids.js";
import { type DurableCommandRecord, DurableEffectRecord, DurableTurnRecord, DurableWorkspaceCheckpoint, RuntimeStateStore, TurnStatus } from "./runtime-state.js";
/**
 * Small crash-safe runtime state store for a single control-plane process.
 * Writes are serialized and use temp-file + rename. For multi-writer production
 * deployments replace this with a transactional database implementation.
 */
export declare class JsonFileRuntimeStateStore implements RuntimeStateStore {
    #private;
    private readonly path;
    constructor(path: string);
    putCommand(record: DurableCommandRecord): Promise<void>;
    getCommand(id: string): Promise<DurableCommandRecord | undefined>;
    putWorkspaceCheckpoint(checkpoint: DurableWorkspaceCheckpoint): Promise<void>;
    getWorkspaceCheckpoint(workspaceId: WorkspaceId): Promise<DurableWorkspaceCheckpoint | undefined>;
    putTurn(record: DurableTurnRecord): Promise<void>;
    getTurn(id: string): Promise<DurableTurnRecord | undefined>;
    listTurns(status?: TurnStatus): Promise<DurableTurnRecord[]>;
    putEffect(record: DurableEffectRecord): Promise<void>;
    getEffect(id: string): Promise<DurableEffectRecord | undefined>;
}
