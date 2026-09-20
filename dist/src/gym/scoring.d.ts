export type GymOutcome = "passed" | "failed" | "tampered" | "timed-out" | "errored";
export interface GymScore {
    outcome: GymOutcome;
    /** Paths the patch touched (repo-relative). */
    touchedPaths: string[];
    detail?: string;
    hiddenOutput?: string;
}
/** Paths an agent must not change: the visible test and the runner config. */
export declare const PROTECTED_PATTERNS: readonly RegExp[];
/** Repo-relative paths a unified diff touches. */
export declare function parsePatchPaths(patchText: string): string[];
export declare function isTampering(paths: readonly string[]): boolean;
export interface ScoreGymPatchOptions {
    patchText: string;
    /** A checkout of the pinned base commit (scoring clones it, so it is untouched). */
    baseRepoDir: string;
    /** Absolute path to the held-out test the agent never sees. */
    hiddenTestPath: string;
    /** Where to place the hidden test inside the clone (default `hidden.test.mjs`). */
    hiddenTestDest?: string;
    timeoutMs?: number;
    nodeBin?: string;
}
export declare function scoreGymPatch(options: ScoreGymPatchOptions): Promise<GymScore>;
