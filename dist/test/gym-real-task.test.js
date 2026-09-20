/**
 * Solidify the gym scorer on a REAL pinned repo (`he`).
 *
 * The committed task fixture plants a genuine one-line bug in `he.js` and ships
 * the held-out vectors as data the verifier holds. The matrix: the bugged tree
 * fails, the golden fix passes, a partial fix that passes the visible test fails
 * the held-out vectors, tampering is distinct, and agent code that exits 0 cannot
 * score.
 *
 * Zero model calls. A cold fixture cache SKIPs (never a vacuous pass).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { scoreGymPatch } from "../src/index.js";
import { FixtureUnavailableError, REAL_REPOS, repoCachePath } from "./fixtures/real-repos.js";
const execFileAsync = promisify(execFile);
// Fixture JSON/mjs are not compiled by tsc, so locate them in the source tree
// (dist/test/ -> ../../test/fixtures/...), not next to the compiled test.
const FIXTURE_DIR = fileURLToPath(new URL("../../test/fixtures/gym-tasks/he/decimal-option/", import.meta.url));
async function loadTask() {
    return JSON.parse(await readFile(join(FIXTURE_DIR, "task.json"), "utf8"));
}
async function loadCases(task) {
    return JSON.parse(await readFile(join(FIXTURE_DIR, task.hiddenCases), "utf8"));
}
async function git(cwd, ...args) {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
}
async function cacheOrSkip(t, repo) {
    try {
        return await repoCachePath(repo);
    }
    catch (error) {
        if (error instanceof FixtureUnavailableError) {
            t.skip(error.message);
            return undefined;
        }
        throw error;
    }
}
/** Clone the pinned commit, plant the bug, place the visible test, and COMMIT —
 * scoring clones baseRepoDir, so uncommitted changes would not travel. */
async function materializeBugged(parent, cache, task) {
    const repo = join(parent, "task");
    await execFileAsync("git", ["clone", "-q", cache, repo]);
    await git(repo, "checkout", "-q", task.commit);
    await execFileAsync("git", ["-C", repo, "apply", join(FIXTURE_DIR, task.bugPatch)]);
    const visibleDest = join(repo, task.visibleTestPath);
    await mkdir(join(visibleDest, ".."), { recursive: true });
    await copyFile(join(FIXTURE_DIR, "visible.test.mjs"), visibleDest);
    await git(repo, "add", "-A");
    await git(repo, "-c", "user.email=t@example.com", "-c", "user.name=tester", "commit", "-q", "-m", "plant bug and visible test");
    return repo;
}
/** Produce a patch by mutating the committed (bugged) repo, diffing, restoring. */
async function patchFrom(repo, mutate) {
    await mutate(repo);
    const patch = await git(repo, "diff");
    await git(repo, "checkout", "--", ".");
    return patch;
}
/** The bug's own reverse: applying it to the bugged repo yields the clean tree. */
async function goldenFixPatch(repo, task) {
    await execFileAsync("git", ["-C", repo, "apply", "-R", join(FIXTURE_DIR, task.bugPatch)]);
    const patch = await git(repo, "diff");
    await git(repo, "checkout", "--", ".");
    return patch;
}
/** Run a test file inside a checkout; returns the exit code. */
async function runTest(repo, relativePath) {
    // The outer `node --test` sets NODE_TEST_CONTEXT; if the child inherits it,
    // it believes it is a test subprocess and skips every file, exiting 0.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    try {
        await execFileAsync(process.execPath, ["--test", relativePath], { cwd: repo, env });
        return 0;
    }
    catch (error) {
        return error.code ?? 1;
    }
}
test("the held-out vectors fail on the bugged checkout and pass on the golden fix", async (t) => {
    const repo = REAL_REPOS.find((entry) => entry.name === "he");
    assert.ok(repo, "he must be in REAL_REPOS");
    const cache = await cacheOrSkip(t, repo);
    if (!cache)
        return;
    const task = await loadTask();
    const cases = await loadCases(task);
    const parent = await mkdtemp(join(tmpdir(), "gym-he-"));
    try {
        const bugged = await materializeBugged(parent, cache, task);
        assert.equal((await scoreGymPatch({ patchText: "", baseRepoDir: bugged, cases })).outcome, "failed", "the bugged tree must fail the held-out vectors");
        const golden = await goldenFixPatch(bugged, task);
        assert.equal((await scoreGymPatch({ patchText: golden, baseRepoDir: bugged, cases })).outcome, "passed", "the bug's own reverse must pass");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("the fixture contract: bug applies cleanly, visible test fails on bug and passes on clean", async (t) => {
    const repo = REAL_REPOS.find((entry) => entry.name === "he");
    assert.ok(repo, "he must be in REAL_REPOS");
    const cache = await cacheOrSkip(t, repo);
    if (!cache)
        return;
    const task = await loadTask();
    const parent = await mkdtemp(join(tmpdir(), "gym-he-"));
    try {
        const bugged = await materializeBugged(parent, cache, task);
        assert.notEqual(await runTest(bugged, task.visibleTestPath), 0, "the visible test must FAIL on the bug");
        await execFileAsync("git", ["-C", bugged, "apply", "-R", join(FIXTURE_DIR, task.bugPatch)]);
        assert.equal(await runTest(bugged, task.visibleTestPath), 0, "the visible test must PASS once fixed");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("scoring matrix on the real he task", async (t) => {
    const repo = REAL_REPOS.find((entry) => entry.name === "he");
    assert.ok(repo, "he must be in REAL_REPOS");
    const cache = await cacheOrSkip(t, repo);
    if (!cache)
        return;
    const task = await loadTask();
    const cases = await loadCases(task);
    const parent = await mkdtemp(join(tmpdir(), "gym-he-"));
    try {
        const bugged = await materializeBugged(parent, cache, task);
        const score = (patchText) => scoreGymPatch({ patchText, baseRepoDir: bugged, cases });
        const golden = await goldenFixPatch(bugged, task);
        assert.equal((await score(golden)).outcome, "passed", "the bug's own reverse must pass");
        // A partial fix that passes the VISIBLE test but not the held-out vectors.
        const partial = await patchFrom(bugged, async (dir) => {
            const path = join(dir, "he.js");
            const source = await readFile(path, "utf8");
            await writeFile(path, source.replace("var escapeCodePoint = hexEscape; // BUG: decimal option ignored", "var escapeCodePoint = decEscape;"));
        });
        assert.equal((await score(partial)).outcome, "failed", "a partial fix must not score");
        const tamper = await patchFrom(bugged, async (dir) => {
            await writeFile(join(dir, task.visibleTestPath), "// deleted\n");
        });
        assert.equal((await score(tamper)).outcome, "tampered", "editing the visible test is tampering");
        const exitZero = await patchFrom(bugged, async (dir) => {
            const path = join(dir, "he.js");
            const source = await readFile(path, "utf8");
            await writeFile(path, `process.exit(0);\n${source}`);
        });
        assert.notEqual((await score(exitZero)).outcome, "passed", "a top-level exit(0) must never score");
        assert.equal((await score("this is not a patch")).outcome, "errored");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
