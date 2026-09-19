import type { KubernetesResourceClass } from "../resource-class.js";
import type { SandboxBackend, WarmSandboxLease } from "./types.js";
export declare class WarmSandboxPool {
    #private;
    constructor(backend: SandboxBackend, classes: readonly KubernetesResourceClass[]);
    maintain(): Promise<void>;
    acquire(resourceClassId: string): Promise<WarmSandboxLease>;
    close(): Promise<void>;
    stats(): Record<string, {
        ready: number;
        leased: number;
        creating: number;
        total: number;
        waiting: number;
    }>;
}
