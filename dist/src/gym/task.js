/**
 * Gym tasks: plant a bug as a committed reverse patch, reproducibly.
 *
 * A task is a checked-in fixture `{repo, commit, mutationPatch, visibleTestPath,
 * hiddenTestPath, seed}` under `test/fixtures/gym-tasks/<repo>/<slug>/`. The bug
 * is a committed mutation of a pinned upstream commit rather than an artifact
 * invented at run time, so reproducibility is byte-identity of the fixture and
 * no model call is spent inventing bugs.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID: `baseRepoDir` (what scoring clones) must
 * be the BUGGED checkout, committed. If it were the clean upstream commit, an
 * empty patch would score `passed` and the whole benchmark would be meaningless.
 * `materializeGymTask` commits the mutation, and the tests assert both that the
 * hidden test fails on the freshly materialized repo and that an empty patch
 * does NOT pass.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
/** Same default as `test/fixtures/real-repos.ts`, overridable by env. */
export const DEFAULT_GYM_FIXTURE_CACHE_DIR = "/tmp/opencode/fixture-repos";
/** Raised when the pinned repo is not in the local fixture cache (offline). */
export class GymFixtureUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "GymFixtureUnavailableError";
    }
}
export const VISIBLE_TEST_FIXTURE = "visible.test.mjs";
export const MUTATION_PATCH_FIXTURE = "bug.patch";
export const TASK_DESCRIPTOR_FIXTURE = "task.json";
export const HIDDEN_CASES_FIXTURE = "hidden.cases.json";
function requireString(value, field, where) {
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`gym task ${where} is missing string field "${field}"`);
    return value;
}
/** Load and validate one checked-in task fixture directory. */
export async function loadGymTask(taskDir) {
    const raw = JSON.parse(await readFile(join(taskDir, TASK_DESCRIPTOR_FIXTURE), "utf8"));
    const repo = requireString(raw.repo, "repo", taskDir);
    const commit = requireString(raw.commit, "commit", taskDir);
    const slug = requireString(raw.slug, "slug", taskDir);
    const visibleTestPath = requireString(raw.visibleTestPath, "visibleTestPath", taskDir);
    const hiddenField = requireString(raw.hiddenTestPath, "hiddenTestPath", taskDir);
    const hiddenTestPath = isAbsolute(hiddenField) ? hiddenField : join(taskDir, hiddenField);
    const seed = typeof raw.seed === "number" ? raw.seed : 0;
    const mutationPatch = await readFile(join(taskDir, MUTATION_PATCH_FIXTURE), "utf8");
    if (mutationPatch.trim().length === 0)
        throw new Error(`gym task ${taskDir} has an empty ${MUTATION_PATCH_FIXTURE}`);
    let hiddenCases;
    try {
        const parsed = JSON.parse(await readFile(join(taskDir, HIDDEN_CASES_FIXTURE), "utf8"));
        hiddenCases = Array.isArray(parsed) ? parsed : parsed.cases;
        if (hiddenCases && hiddenCases.length === 0) {
            // An empty held-out set must not be silently treated as "no cases": the
            // scorer refuses a vacuous pass, but fail loudly here too.
            throw new Error(`gym task ${taskDir} has an empty ${HIDDEN_CASES_FIXTURE}`);
        }
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    return { repo, commit, seed, visibleTestPath, hiddenTestPath, mutationPatch, taskDir, slug, ...(hiddenCases ? { hiddenCases } : {}) };
}
async function git(cwd, ...args) {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
}
async function gitInfo(cwd, ...args) {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
}
/** Apply a patch to a checkout; throws with git's own message on failure. */
async function applyPatchFile(cwd, patchText, reverse = false) {
    const dir = await mkdtemp(join(tmpdir(), "gym-apply-"));
    try {
        const file = join(dir, "change.patch");
        await writeFile(file, patchText);
        await execFileAsync("git", ["apply", ...(reverse ? ["-R"] : []), file], { cwd, maxBuffer: 32 * 1024 * 1024 });
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
/**
 * Clone the pinned commit from the local fixture cache, plant the visible test,
 * apply `bug.patch`, and COMMIT the result. The returned `baseRepoDir` is the
 * bugged committed checkout; a fresh clone of it reproduces the bug exactly.
 */
export async function materializeGymTask(options) {
    const { task } = options;
    const cacheRoot = options.fixtureCacheDir ?? process.env.SYNTH_FIXTURE_REPOS ?? DEFAULT_GYM_FIXTURE_CACHE_DIR;
    const cache = join(cacheRoot, `${task.repo}.git`);
    try {
        await access(join(cache, "HEAD"), constants.R_OK);
    }
    catch {
        throw new GymFixtureUnavailableError(`fixture repo ${task.repo} is not in the cache at ${cache}; set SYNTH_FIXTURE_REPOS or warm the cache`);
    }
    await mkdir(options.workDir, { recursive: true });
    const repoDir = join(options.workDir, options.repoDirName ?? `${task.slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    await rm(repoDir, { recursive: true, force: true });
    await execFileAsync("git", ["clone", "-q", "--no-hardlinks", cache, repoDir]);
    await git(repoDir, "checkout", "-q", task.commit);
    await git(repoDir, "config", "user.email", "gym@example.invalid");
    await git(repoDir, "config", "user.name", "gym-harness");
    const visibleTestPath = join(repoDir, task.visibleTestPath);
    await mkdir(dirname(visibleTestPath), { recursive: true });
    await copyFile(join(task.taskDir, VISIBLE_TEST_FIXTURE), visibleTestPath);
    await applyPatchFile(repoDir, task.mutationPatch);
    await git(repoDir, "add", "-A");
    await git(repoDir, "commit", "-q", "-m", `plant gym bug: ${task.slug}`);
    const bugCommit = await gitInfo(repoDir, "rev-parse", "HEAD");
    return {
        task,
        repoDir,
        baseRepoDir: repoDir,
        visibleTestPath,
        hiddenTestPath: task.hiddenTestPath,
        bugCommit,
        baseCommit: task.commit,
    };
}
/**
 * Materialize directly from a fixture directory (load + materialize).
 */
export async function materializeGymTaskFromDir(taskDir, options) {
    return materializeGymTask({ task: await loadGymTask(taskDir), ...options });
}
/**
 * Build the golden control: the reverse of the planted bug, i.e. the fix.
 *
 * `git apply -R` against a scratch clone of the BUGGED checkout restores the
 * clean state, and `git diff` then emits the bugged -> clean patch. Scoring that
 * patch with `scoreGymPatch({ baseRepoDir: bugged })` must return `passed`; it
 * proves the pipeline is wired before any agent is involved.
 */
export async function goldenReversePatch(baseRepoDir, mutationPatch) {
    const work = await mkdtemp(join(tmpdir(), "gym-golden-"));
    try {
        const clone = join(work, "clone");
        await execFileAsync("git", ["clone", "-q", baseRepoDir, clone]);
        await applyPatchFile(clone, mutationPatch, true);
        await git(clone, "add", "-A");
        const { stdout } = await execFileAsync("git", ["diff", "--cached", "HEAD"], { cwd: clone, maxBuffer: 32 * 1024 * 1024 });
        return stdout;
    }
    finally {
        await rm(work, { recursive: true, force: true });
    }
}
