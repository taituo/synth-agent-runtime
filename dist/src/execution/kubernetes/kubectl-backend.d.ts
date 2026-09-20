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
 * `kubectl delete pod X networkpolicy Y` does NOT mean "delete pod X and
 * networkpolicy Y" — kubectl reads the first positional argument after the
 * verb as the resource TYPE, and every following non-flag token as another
 * NAME of that same type. It tries to delete pods named X, "networkpolicy",
 * and Y; the real NetworkPolicy object is never targeted. With
 * `--ignore-not-found`, the bogus lookups fail silently and the exit code is
 * 0, so the leak goes unnoticed. The `type/name` form deletes heterogeneous
 * resources correctly in one call.
 */
export declare function deletePodAndPolicyArgs(podName: string, namespace: string): string[];
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
    writeSymlink(sandbox: SandboxIdentity, path: string, target: string): Promise<void>;
    readSymlink(sandbox: SandboxIdentity, path: string): Promise<string>;
    listGitChanges(sandbox: SandboxIdentity): Promise<Array<{
        path: string;
        deleted: boolean;
        symlink?: boolean;
    }>>;
}
