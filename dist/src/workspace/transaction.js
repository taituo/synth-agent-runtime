/**
 * Transaction boundary for synthetic turns. Mutations stay in the same workspace
 * while the callback runs; any failure restores the exact RAM overlay snapshot.
 */
export async function withWorkspaceTransaction(workspace, run) {
    const snapshot = await workspace.snapshot();
    try {
        const value = await run();
        return { value, committed: true };
    }
    catch (error) {
        workspace.restore(snapshot);
        throw error;
    }
}
export class WorkspaceTransaction {
    workspace;
    snapshot;
    #closed = false;
    constructor(workspace, snapshot) {
        this.workspace = workspace;
        this.snapshot = snapshot;
    }
    static async begin(workspace) {
        return new WorkspaceTransaction(workspace, await workspace.snapshot());
    }
    commit() {
        if (this.#closed)
            throw new Error("Workspace transaction already closed");
        this.#closed = true;
    }
    rollback() {
        if (this.#closed)
            throw new Error("Workspace transaction already closed");
        this.workspace.restore(this.snapshot);
        this.#closed = true;
    }
}
