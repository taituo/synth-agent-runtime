/**
 * Real public repositories, pinned by commit SHA, for workspace-fixture tests.
 *
 * Track 1 of the realistic suite: `NativeGitSource` and the K8s executor claim
 * to clone/sync real repos, so the tests use real ones rather than a fixture we
 * invented. Repos are cloned ONCE into a cache dir outside the repo; tests copy
 * from the cache (NativeGitSource fetches from it as a local git remote), so
 * the network is never on the test's critical path.
 *
 * If the cache is cold and the clone fails (offline), `repoCachePath` throws
 * `FixtureUnavailableError`; tests catch it and SKIP with a clear message —
 * they never pass vacuously and never fail for a network reason.
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export const DEFAULT_FIXTURE_CACHE_DIR = "/tmp/opencode/fixture-repos";
/** Read at call time so tests can point at a scratch cache. */
function cacheRoot() {
    return process.env.SYNTH_FIXTURE_REPOS ?? DEFAULT_FIXTURE_CACHE_DIR;
}
/** Small, permissively licensed, genuinely different repos. */
export const REAL_REPOS = [
    { name: "he", url: "https://github.com/mathiasbynens/he", commit: "36afe179392226cf1b6ccdb16ebbb7a5a844d93a", license: "MIT" },
    { name: "commander", url: "https://github.com/tj/commander.js", commit: "ba6d13ddb4243e5913367734f8c159089ffe7834", license: "MIT" },
    { name: "jsyaml", url: "https://github.com/nodeca/js-yaml", commit: "494400bd45cad078123cfc057e674a9a0a8d9983", license: "MIT" },
    { name: "emoj", url: "https://github.com/sindresorhus/emoj", commit: "af4eefdcc16ba1b43ef496bb717eae84fbffd066", license: "MIT" },
];
export class FixtureUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "FixtureUnavailableError";
    }
}
/** Path to the cached bare repo, cloning once if cold; throws when offline. */
export async function repoCachePath(repo) {
    const dir = join(cacheRoot(), `${repo.name}.git`);
    try {
        await access(join(dir, "HEAD"));
        return dir;
    }
    catch {
        // cold cache: clone once
    }
    try {
        await execFileAsync("git", ["clone", "--bare", "-q", repo.url, dir], {
            timeout: 180_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        // Allow fetching the pinned SHA directly (not just branch tips).
        await execFileAsync("git", ["-C", dir, "config", "uploadpack.allowAnySHA1InWant", "true"]);
    }
    catch (error) {
        throw new FixtureUnavailableError(`fixture repo ${repo.name} cache is cold and clone failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return dir;
}
/** The repo's file list at `commit`, straight from git (ground truth). */
export async function listTreeFiles(cachePath, commit) {
    const { stdout } = await execFileAsync("git", ["-C", cachePath, "ls-tree", "-r", "-z", "--name-only", commit], {
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
    });
    return String(stdout).split("\0").filter(Boolean);
}
/** Raw blob bytes at `commit:path`, straight from git (ground truth). */
export async function blobBytes(cachePath, commit, path) {
    const { stdout } = await execFileAsync("git", ["-C", cachePath, "cat-file", "blob", `${commit}:${path}`], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
}
