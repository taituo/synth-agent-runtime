import { type EffectRunner } from "../../src/index.js";
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
}
export interface SandboxRunner {
    runner: EffectRunner;
    close(): Promise<void>;
}
/** Construct the broker-backed runner. Throws if the image is missing. */
export declare function buildSandboxRunner(options: BuildSandboxRunnerOptions): Promise<SandboxRunner>;
