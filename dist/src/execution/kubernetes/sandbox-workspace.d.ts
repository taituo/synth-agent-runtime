import type { WorkspaceId } from "../../core/ids.js";
import type { BlobStore } from "../../artifacts/blob-store.js";
import { MemoryWorkspace } from "../../workspace/memory-workspace.js";
import type { ArtifactRef, Effect, EffectContext, EffectResult, Executor } from "../types.js";
import type { KubernetesResourceClass } from "../resource-class.js";
import { WarmSandboxPool } from "./pool.js";
import type { SandboxBackend } from "./types.js";
import { WorkspaceSynchronizer } from "./workspace-sync.js";
export interface SandboxWorkspaceExecutorOptions {
    resourceClass: KubernetesResourceClass;
    backend: SandboxBackend;
    /**
     * Seed/checkpoint cache only. The pod's filesystem is the medium for a
     * sandboxed run; this workspace is materialized in once and synced back on
     * `checkpoint()`. It is never the read/write medium.
     */
    workspaces?: Map<WorkspaceId, MemoryWorkspace>;
    pool?: WarmSandboxPool;
    synchronizer?: WorkspaceSynchronizer;
    defaultTimeoutMs?: number;
}
/**
 * The sandbox rung's executor: `workspace.read/write/list/delete` AND
 * `process.exec` all execute inside a persistent executor Pod, so the
 * model-authored workspace is boundary-enforced rather than living in worker
 * RAM. `MemoryWorkspace` is only the seed/checkpoint cache.
 *
 * The Pod is held for the workspace's lifetime in this worker process, so a
 * write followed by a read sees the same filesystem. Durability across a worker
 * restart comes from `checkpoint()` (sync the pod back into the cache) plus the
 * caller persisting that snapshot via `snapshot-codec` and the blob store; a
 * fresh worker restores the snapshot and materializes it into a new pod.
 */
export declare class SandboxWorkspaceExecutor implements Executor {
    #private;
    readonly id: string;
    readonly fidelity: number;
    readonly resourceClassId: string;
    constructor(options: SandboxWorkspaceExecutorOptions);
    canExecute(effect: Effect, context: EffectContext): boolean;
    execute(effect: Effect, context: EffectContext): Promise<EffectResult>;
    /**
     * Sync the pod workspace back into the cache workspace, so the caller can
     * persist a snapshot. Returns false when there is no pod for the workspace.
     */
    checkpoint(workspaceId: WorkspaceId): Promise<boolean>;
    /** True when this executor holds a live pod for the workspace. */
    hasSandbox(workspaceId: WorkspaceId): boolean;
    /** The seed/checkpoint cache workspace, if one was supplied. */
    workspace(workspaceId: WorkspaceId): MemoryWorkspace | undefined;
    /** Destroy every held pod. Call at the end of a run. */
    close(): Promise<void>;
}
/**
 * Durably checkpoint a sandboxed workspace: sync the pod back into its cache
 * workspace, then write the workspace diff to the blob store. Reuses the
 * existing diff/snapshot codec and the blob store — no second store.
 * Returns undefined when there is no live pod for the workspace.
 */
export declare function checkpointSandboxWorkspace(executor: SandboxWorkspaceExecutor, workspaceId: WorkspaceId, blobStore: BlobStore): Promise<ArtifactRef | undefined>;
/**
 * Restore a checkpointed sandbox workspace into a fresh cache workspace, which
 * the next sandbox executor materializes into a new pod. The bytes come from
 * the blob store by digest, not from host RAM.
 */
export declare function restoreSandboxWorkspace(blobStore: BlobStore, digest: string, workspace: MemoryWorkspace): Promise<void>;
