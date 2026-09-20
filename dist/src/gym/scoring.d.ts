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
/**
 * Every path-like token a unified diff mentions, taking BOTH sides of a rename
 * or copy and the `---`/`+++` headers as well as the `diff --git` line. Taking
 * only the `b/` side of `diff --git` misses a rename that moves a protected file
 * away under a new name, and a hand-crafted patch can omit the `diff --git`
 * header entirely while still applying. Over-reporting is safe here: an extra
 * path can only make the tampering check stricter.
 */
export declare function parsePatchPaths(patchText: string): string[];
/**
 * Repo-relative paths a patch targets, according to git's own patch parser.
 * `git apply --numstat` lists what a patch will touch even when it would not
 * apply (wrong context) and even without a `diff --git` header, and it decodes
 * git's quoted/octal-escaped paths. The raw parse is unioned in to catch the
 * original name of a rename, which `--numstat` reports only under the new name.
 */
export declare function patchTargetPaths(patchText: string): Promise<string[]>;
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
