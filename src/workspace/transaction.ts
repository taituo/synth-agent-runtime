import { MemoryWorkspace, type WorkspaceSnapshot } from "./memory-workspace.js";

export interface WorkspaceTransactionResult<T> {
  value: T;
  committed: true;
}

/**
 * Transaction boundary for synthetic turns. Mutations stay in the same workspace
 * while the callback runs; any failure restores the exact RAM overlay snapshot.
 */
export async function withWorkspaceTransaction<T>(
  workspace: MemoryWorkspace,
  run: () => Promise<T>,
): Promise<WorkspaceTransactionResult<T>> {
  const snapshot = await workspace.snapshot();
  try {
    const value = await run();
    return { value, committed: true };
  } catch (error) {
    workspace.restore(snapshot);
    throw error;
  }
}

export class WorkspaceTransaction {
  readonly snapshot: WorkspaceSnapshot;
  #closed = false;

  private constructor(private readonly workspace: MemoryWorkspace, snapshot: WorkspaceSnapshot) {
    this.snapshot = snapshot;
  }

  static async begin(workspace: MemoryWorkspace): Promise<WorkspaceTransaction> {
    return new WorkspaceTransaction(workspace, await workspace.snapshot());
  }

  commit(): void {
    if (this.#closed) throw new Error("Workspace transaction already closed");
    this.#closed = true;
  }

  rollback(): void {
    if (this.#closed) throw new Error("Workspace transaction already closed");
    this.workspace.restore(this.snapshot);
    this.#closed = true;
  }
}
