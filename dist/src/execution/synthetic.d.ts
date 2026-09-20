import type { WorkspaceId } from "../core/ids.js";
import type { BlobStore } from "../artifacts/blob-store.js";
import { MemoryWorkspace } from "../workspace/memory-workspace.js";
import type { Effect, EffectContext, EffectResult, Executor } from "./types.js";
/** Lowest-fidelity executor: deterministic workspace operations only. */
export declare class SyntheticExecutor implements Executor {
    #private;
    private readonly blobStore?;
    readonly id = "synthetic";
    readonly fidelity = 0;
    constructor(workspaces: Map<WorkspaceId, MemoryWorkspace>, blobStore?: BlobStore | undefined);
    canExecute(effect: Effect): boolean;
    execute(effect: Effect, context: EffectContext): Promise<EffectResult>;
}
