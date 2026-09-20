export declare const DEFAULT_FIXTURE_CACHE_DIR = "/tmp/opencode/fixture-repos";
export interface RealRepo {
    name: string;
    url: string;
    /** Pinned commit SHA (never a branch — the suite must not rot). */
    commit: string;
    license: string;
}
/** Small, permissively licensed, genuinely different repos. */
export declare const REAL_REPOS: readonly RealRepo[];
export declare class FixtureUnavailableError extends Error {
    constructor(message: string);
}
/** Path to the cached bare repo, cloning once if cold; throws when offline. */
export declare function repoCachePath(repo: RealRepo): Promise<string>;
/** The repo's file list at `commit`, straight from git (ground truth). */
export declare function listTreeFiles(cachePath: string, commit: string): Promise<string[]>;
/** Raw blob bytes at `commit:path`, straight from git (ground truth). */
export declare function blobBytes(cachePath: string, commit: string, path: string): Promise<Buffer>;
