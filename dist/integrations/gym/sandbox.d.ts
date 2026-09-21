import { type BlobStore, type Effect, type EffectResult, type KubernetesResourceClass, type SandboxBackend, type EffectRunner } from "../../src/index.js";
export interface BuildSandboxRunnerOptions {
    /** Materialized bugged checkout (its tracked tree is materialized into the Pod). */
    repoDir: string;
    /**
     * node+git-capable image pinned by digest. The Pod runs the agent's
     * `run_visible_test`, so it must have node as well as git — a git-only image
     * such as `alpine/git` makes the tool exit 127. Example:
     * `docker.io/library/node:22-bookworm@sha256:dd5847a0...`.
     */
    image: string;
    namespace?: string;
    kubectlContext?: string;
    runtimeClassName?: string;
    agentId?: string;
    /**
     * Seed the cache workspace from a durable checkpoint before the first effect
     * materializes the Pod. Used on a cold worker (after a SIGKILL) so the resumed
     * attempt continues from the crashed attempt's committed edits instead of the
     * bugged source. The digest comes from the existing blob store.
     */
    restore?: {
        blobStore: BlobStore;
        digest: string;
    };
    /** Test seam: a fake "pod" backend instead of kubectl. */
    backend?: SandboxBackend;
    /** Test seam: override the resource class. */
    resourceClass?: KubernetesResourceClass;
}
export interface SandboxRunner {
    runner: EffectRunner;
    /**
     * Execute an execution-rung effect through the broker (the same path the
     * runtime turn's `executeEffect` uses). Every workspace effect and
     * `process.exec` runs in the pod.
     */
    executeEffect(effect: Effect, minFidelity?: number): Promise<EffectResult>;
    /**
     * Durably checkpoint the pod workspace into `blobStore` (sync the pod back,
     * then write the workspace diff) and return the digest. Undefined when there
     * is no live pod (no effect ran this turn), so the caller carries the previous
     * digest forward rather than dropping the reference.
     */
    checkpointWorkspace(blobStore: BlobStore): Promise<string | undefined>;
    close(): Promise<void>;
}
export declare function hasPersistentSandboxRunner(key: string): boolean;
/** Close and forget the runner for `key` (destroys its pod). */
export declare function releasePersistentSandboxRunner(key: string): Promise<void>;
/** Reuse the runner for `key` if it exists, else build and cache it. */
export declare function getPersistentSandboxRunner(options: BuildSandboxRunnerOptions & {
    key: string;
}): Promise<SandboxRunner>;
/** Construct the broker-backed runner. Throws if the image is missing. */
export declare function buildSandboxRunner(options: BuildSandboxRunnerOptions): Promise<SandboxRunner>;
