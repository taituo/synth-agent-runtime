/** Lowest-fidelity executor: deterministic workspace operations only. */
export class SyntheticExecutor {
    id = "synthetic";
    fidelity = 0;
    #workspaces;
    constructor(workspaces) {
        this.#workspaces = workspaces;
    }
    canExecute(effect) {
        return effect.kind.startsWith("workspace.") || effect.kind === "process.exec";
    }
    async execute(effect, context) {
        const workspace = this.#workspaces.get(context.workspaceId);
        if (!workspace)
            return { ok: false, error: `Unknown workspace ${context.workspaceId}` };
        switch (effect.kind) {
            case "workspace.read":
                return { ok: true, output: await workspace.read(effect.path) };
            case "workspace.write":
                workspace.write(effect.path, effect.content);
                return { ok: true };
            case "workspace.delete":
                workspace.delete(effect.path);
                return { ok: true };
            case "workspace.list":
                return { ok: true, output: await workspace.listDir(effect.path) };
            case "process.exec":
                return { ok: false, error: "ESCALATION_REQUIRED" };
            default:
                return { ok: false, error: "ESCALATION_REQUIRED" };
        }
    }
}
