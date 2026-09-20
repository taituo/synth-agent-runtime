import type { GymOutcome } from "./scoring.js";
/** One assertion the verifier holds: call `module[call](...args)` and expect `expect`. */
export interface GymCase {
    /** Repo-relative (or worker-cwd-relative) module path, e.g. "./he.js". */
    module: string;
    call: string;
    args: unknown[];
    expect: unknown;
    label?: string;
}
export interface GymCaseResult {
    label?: string;
    ok: boolean;
    error?: string;
}
export interface IsolatedScore {
    outcome: GymOutcome;
    touchedPaths: string[];
    cases: GymCaseResult[];
    detail?: string;
}
export interface IsolatedScoreOptions {
    patchText: string;
    /** A checkout of the pinned BUGGED commit. Scoring clones it, so it is untouched. */
    baseRepoDir: string;
    cases: readonly GymCase[];
    timeoutMs?: number;
    nodeBin?: string;
}
/**
 * Apply the agent's patch to a fresh clone and decide `passed`/`failed`/
 * `tampered`/`timed-out`/`errored` from the verifier's own comparison.
 */
export declare function isolatedScoreGymPatch(options: IsolatedScoreOptions): Promise<IsolatedScore>;
/**
 * Adapt an isolated-case score to the `GymScorer` seam used by `runGymAttempt`.
 * `baseRepoDir` must be the BUGGED checkout; the verifier clones it.
 */
export declare function isolatedScorerFor(cases: readonly GymCase[], nodeBin?: string): (request: {
    patchText: string;
    baseRepoDir: string;
}) => Promise<IsolatedScore>;
