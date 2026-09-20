/** Same default as `test/fixtures/real-repos.ts`, overridable by env. */
export declare const DEFAULT_GYM_FIXTURE_CACHE_DIR = "/tmp/opencode/fixture-repos";
/** Raised when the pinned repo is not in the local fixture cache (offline). */
export declare class GymFixtureUnavailableError extends Error {
    constructor(message: string);
}
export interface GymTask {
    /** Name of a Track 1 fixture repo, e.g. "he". */
    repo: string;
    /** Pinned upstream commit the bug is planted on top of. */
    commit: string;
    seed: number;
    /** Repo-relative path where the read-only visible test is planted. */
    visibleTestPath: string;
    /** Absolute path to the held-out test the agent never sees. */
    hiddenTestPath: string;
    /** The clean -> bugged patch, applied and committed by `materializeGymTask`. */
    mutationPatch: string;
    /** Directory the fixture was loaded from; used to locate the visible test. */
    taskDir: string;
    /** Stable identifier for reports. */
    slug: string;
}
export interface GymTaskDescriptor {
    repo: string;
    commit: string;
    slug: string;
    seed: number;
    visibleTestPath: string;
    /** Absolute in a loaded task; relative to the task dir in `task.json`. */
    hiddenTestPath: string;
    /** Standardized name of the visible-test fixture. */
    visibleTestFile?: string;
}
export declare const VISIBLE_TEST_FIXTURE = "visible.test.mjs";
export declare const MUTATION_PATCH_FIXTURE = "bug.patch";
export declare const TASK_DESCRIPTOR_FIXTURE = "task.json";
/** Load and validate one checked-in task fixture directory. */
export declare function loadGymTask(taskDir: string): Promise<GymTask>;
export interface MaterializeGymTaskOptions {
    task: GymTask;
    /** Parent directory; the checkout is created inside it. */
    workDir: string;
    /** Overridable fixture cache root (defaults to env SYNTH_FIXTURE_REPOS). */
    fixtureCacheDir?: string;
    /** Optional explicit directory name; defaults to a unique slug. */
    repoDirName?: string;
}
export interface MaterializedGymTask {
    task: GymTask;
    /** The BUGGED checkout (committed) — this is what scoring must clone. */
    repoDir: string;
    /** Alias of `repoDir`, named for the scorer: never the clean upstream commit. */
    baseRepoDir: string;
    /** Absolute path of the visible test inside `repoDir` (read-only to agents). */
    visibleTestPath: string;
    /** Absolute path of the held-out test (host side, never copied into the repo). */
    hiddenTestPath: string;
    /** Commit SHA of the bugged state. */
    bugCommit: string;
    /** The clean commit the bug was planted on. */
    baseCommit: string;
}
/**
 * Clone the pinned commit from the local fixture cache, plant the visible test,
 * apply `bug.patch`, and COMMIT the result. The returned `baseRepoDir` is the
 * bugged committed checkout; a fresh clone of it reproduces the bug exactly.
 */
export declare function materializeGymTask(options: MaterializeGymTaskOptions): Promise<MaterializedGymTask>;
/**
 * Materialize directly from a fixture directory (load + materialize).
 */
export declare function materializeGymTaskFromDir(taskDir: string, options: Omit<MaterializeGymTaskOptions, "task">): Promise<MaterializedGymTask>;
/**
 * Build the golden control: the reverse of the planted bug, i.e. the fix.
 *
 * `git apply -R` against a scratch clone of the BUGGED checkout restores the
 * clean state, and `git diff` then emits the bugged -> clean patch. Scoring that
 * patch with `scoreGymPatch({ baseRepoDir: bugged })` must return `passed`; it
 * proves the pipeline is wired before any agent is involved.
 */
export declare function goldenReversePatch(baseRepoDir: string, mutationPatch: string): Promise<string>;
