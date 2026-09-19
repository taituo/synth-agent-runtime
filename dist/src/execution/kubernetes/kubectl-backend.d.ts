import type { KubernetesResourceClass } from "../resource-class.js";
import type { SandboxBackend, SandboxExecRequest, SandboxExecResult, SandboxIdentity } from "./types.js";
export interface KubectlSandboxBackendOptions {
    namespace?: string;
    kubectlBin?: string;
    context?: string;
    createTimeoutMs?: number;
    defaultExecTimeoutMs?: number;
}
/**
 * Concrete Kubernetes backend implemented only with kubectl.
 *
 * The trusted control plane owns kubectl credentials. The untrusted executor Pod
 * receives no ServiceAccount token and therefore cannot control Kubernetes.
 */
export declare class KubectlSandboxBackend implements SandboxBackend {
    #private;
    constructor(options?: KubectlSandboxBackendOptions);
    create(resourceClass: KubernetesResourceClass, options?: {
        labels?: Record<string, string>;
        namespace?: string;
    }): Promise<SandboxIdentity>;
    destroy(sandbox: SandboxIdentity): Promise<void>;
    reset(sandbox: SandboxIdentity): Promise<void>;
    verifyReset(sandbox: SandboxIdentity): Promise<boolean>;
    exec(sandbox: SandboxIdentity, request: SandboxExecRequest): Promise<SandboxExecResult>;
    writeFile(sandbox: SandboxIdentity, path: string, content: Uint8Array): Promise<void>;
    readFile(sandbox: SandboxIdentity, path: string): Promise<Uint8Array>;
    removePath(sandbox: SandboxIdentity, path: string): Promise<void>;
    listGitChanges(sandbox: SandboxIdentity): Promise<Array<{
        path: string;
        deleted: boolean;
    }>>;
}
