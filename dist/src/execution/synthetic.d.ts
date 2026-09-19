import type { WorkspaceId } from "../core/ids.js";
import { MemoryWorkspace } from "../workspace/memory-workspace.js";
import type { Effect, EffectContext, EffectResult, Executor } from "./types.js";
/** Lowest-fidelity executor: deterministic workspace operations only. */
export declare class SyntheticExecutor implements Executor {
    #private;
    readonly id = "synthetic";
    readonly fidelity = 0;
    constructor(workspaces: Map<WorkspaceId, MemoryWorkspace>);
    canExecute(effect: Effect): boolean;
    execute(effect: Effect, context: EffectContext): Promise<EffectResult>;
}
