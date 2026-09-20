import type { KubernetesResourceClass } from "../resource-class.js";
import type { SandboxBackend, SandboxExecRequest, SandboxExecResult, SandboxIdentity } from "./types.js";
export interface KubectlSandboxBackendOptions {
    namespace?: string;
    kubectlBin?: string;
    context?: string;
    createTimeoutMs?: number;
    defaultExecTimeoutMs?: number;
}
/** Env var the git-change loop is passed through, so no shell quoting is needed. */
export declare const GIT_CHANGES_LOOP_ENV = "SYNTH_GIT_CHANGES_LOOP";
/**
 * The inner loop that turns `git status -z` into one NUL-separated record per
 * change: path, status, kind, target.
 *
 * `read -d` is a bash/busybox-ash builtin. Debian's `/bin/sh` is dash and rejects
 * it ("Illegal option -d"), which made the loop emit nothing and `syncBack`
 * silently import zero changes. That is invisible with an alpine executor and
 * breaks under the repo's own `node:22-bookworm-slim` executor, so the loop is
 * run under a shell that supports `read -d` (bash when present, else `sh`).
 */
export declare const GIT_CHANGES_LOOP: string;
/**
 * The full command run in the pod. `workspace` is parameterized so the exact
 * script can be exercised in a local test against a real repo.
 */
export declare function gitChangesCommand(workspace?: string): string;
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
