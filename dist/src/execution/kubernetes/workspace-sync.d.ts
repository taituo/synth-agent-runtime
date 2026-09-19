import { MemoryWorkspace } from "../../workspace/memory-workspace.js";
import type { SandboxBackend, SandboxIdentity } from "./types.js";
export interface WorkspaceSyncOptions {
    maxFiles?: number;
    maxBytes?: number;
    initializeGitBaseline?: boolean;
}
/**
 * Safely moves the visible sparse workspace into a physical sandbox without
 * giving repository credentials to the sandbox. The trusted control plane reads
 * the TreeSource; only file bytes enter the untrusted Pod.
 */
export declare class WorkspaceSynchronizer {
    #private;
    constructor(backend: SandboxBackend, options?: WorkspaceSyncOptions);
    materialize(workspace: MemoryWorkspace, sandbox: SandboxIdentity): Promise<void>;
    syncBack(workspace: MemoryWorkspace, sandbox: SandboxIdentity): Promise<void>;
}
