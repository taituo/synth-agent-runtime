import { MemoryWorkspace, type WorkspaceSnapshot } from "./memory-workspace.js";
export interface WorkspaceTransactionResult<T> {
    value: T;
    committed: true;
}
/**
 * Transaction boundary for synthetic turns. Mutations stay in the same workspace
 * while the callback runs; any failure restores the exact RAM overlay snapshot.
 */
export declare function withWorkspaceTransaction<T>(workspace: MemoryWorkspace, run: () => Promise<T>): Promise<WorkspaceTransactionResult<T>>;
export declare class WorkspaceTransaction {
    #private;
    private readonly workspace;
    readonly snapshot: WorkspaceSnapshot;
    private constructor();
    static begin(workspace: MemoryWorkspace): Promise<WorkspaceTransaction>;
    commit(): void;
    rollback(): void;
}
