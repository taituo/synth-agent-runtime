import type { KubernetesResourceClass } from "../resource-class.js";
export type KubernetesObject = Record<string, unknown>;
export interface SandboxIdentity {
    id: string;
    namespace: string;
    podName: string;
    resourceClassId: string;
    createdAt: number;
}
export interface SandboxExecRequest {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
}
export interface SandboxExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
}
export interface SandboxBackend {
    create(resourceClass: KubernetesResourceClass, options?: {
        labels?: Record<string, string>;
        namespace?: string;
    }): Promise<SandboxIdentity>;
    destroy(sandbox: SandboxIdentity): Promise<void>;
    reset(sandbox: SandboxIdentity): Promise<void>;
    /** Optional post-reset proof. Returning false forces warm-pool destruction. */
    verifyReset?(sandbox: SandboxIdentity): Promise<boolean>;
    exec(sandbox: SandboxIdentity, request: SandboxExecRequest): Promise<SandboxExecResult>;
    writeFile(sandbox: SandboxIdentity, path: string, content: Uint8Array): Promise<void>;
    readFile(sandbox: SandboxIdentity, path: string): Promise<Uint8Array>;
    /** Create (or replace) a symlink. Required so the sync path preserves mode 120000. */
    writeSymlink(sandbox: SandboxIdentity, path: string, target: string): Promise<void>;
    /** Read a symlink's target text (does not follow it). */
    readSymlink(sandbox: SandboxIdentity, path: string): Promise<string>;
    removePath(sandbox: SandboxIdentity, path: string): Promise<void>;
    listGitChanges(sandbox: SandboxIdentity): Promise<Array<{
        path: string;
        deleted: boolean;
        symlink?: boolean;
    }>>;
}
export interface WarmSandboxLease {
    sandbox: SandboxIdentity;
    resourceClass: KubernetesResourceClass;
    release(options?: {
        destroy?: boolean;
    }): Promise<void>;
}
export interface ProjectCellService {
    name: string;
    image: string;
    ports?: number[];
    env?: Record<string, string>;
    /**
     * Optional Kubernetes RuntimeClass for the service pod (e.g. "gvisor").
     * Omit or leave empty to use the cluster default runtime; an empty string
     * must never be emitted into the manifest (the API server rejects it).
     */
    runtimeClassName?: string;
    /**
     * Optional numeric uid/gid for the service container and fsGroup for its
     * volumes. The cell namespace enforces the restricted PodSecurity profile
     * with `runAsNonRoot: true`, so images whose own USER is root (databases,
     * caches, ...) fail to start with `CreateContainerConfigError` unless a
     * non-root uid is pinned here. Set these to the image's intended non-root
     * user (e.g. 70 for the official postgres image). Left unset, the image's
     * own USER is used.
     */
    runAsUser?: number;
    runAsGroup?: number;
    fsGroup?: number;
    resources?: {
        cpuRequest?: string;
        cpuLimit?: string;
        memoryRequest?: string;
        memoryLimit?: string;
    };
}
export interface ProjectCellSpec {
    id: string;
    namespace?: string;
    resourceClassId?: string;
    services?: ProjectCellService[];
    labels?: Record<string, string>;
    idleTtlMs?: number;
}
export interface ProjectCellHandle {
    id: string;
    namespace: string;
    executor: SandboxIdentity;
    serviceNames: string[];
    createdAt: number;
}
