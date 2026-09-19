import type { WorkspaceId } from "../../core/ids.js";
import { MemoryWorkspace } from "../../workspace/memory-workspace.js";
import type { Effect, EffectContext, EffectResult, Executor } from "../types.js";
import type { KubernetesResourceClass } from "../resource-class.js";
import { WarmSandboxPool } from "./pool.js";
import type { SandboxBackend } from "./types.js";
import { WorkspaceSynchronizer } from "./workspace-sync.js";
export interface KubernetesExecutorOptions {
    resourceClass: KubernetesResourceClass;
    backend: SandboxBackend;
    workspaces: Map<WorkspaceId, MemoryWorkspace>;
    pool?: WarmSandboxPool;
    synchronizer?: WorkspaceSynchronizer;
}
/** Physical executor for commands that the synthetic environment cannot run. */
export declare class KubernetesExecutor implements Executor {
    #private;
    readonly id: string;
    readonly fidelity: number;
    readonly resourceClassId: string;
    constructor(options: KubernetesExecutorOptions);
    canExecute(effect: Effect, context: EffectContext): boolean;
    execute(effect: Effect, context: EffectContext): Promise<EffectResult>;
}
