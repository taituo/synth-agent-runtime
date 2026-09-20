/**
 * Step 1: gym tasks materialize a BUGGED committed checkout and the golden
 * reverse patch scores `passed`.
 *
 * The discriminating assertions (the benchmark is meaningless without them):
 *   - the hidden test FAILS on a freshly materialized task;
 *   - an EMPTY patch does NOT score `passed` (baseRepoDir is the bug, not clean);
 *   - the bug's own reverse patch scores `passed`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GymFixtureUnavailableError,
  goldenReversePatch,
  isolatedScoreGymPatch,
  loadGymTask,
  materializeGymTask,
  DEFAULT_GYM_FIXTURE_CACHE_DIR,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const CLEAN = `export function slugify(text) {\n  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n`;
const BUGGED = `export function slugify(text) {\n  return String(text).toUpperCase().replace(/[^A-Z0-9]+/g, "-");\n}\n`;
const VISIBLE = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../lib.mjs";\ntest("lowercases and hyphenates", () => { assert.equal(slugify("Hello World"), "hello-world"); });\n`;
const HIDDEN = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { slugify } from "./lib.mjs";',
  'test("hidden edge cases", () => { assert.equal(slugify(""), ""); assert.equal(slugify("  A  B "), "a-b"); assert.equal(slugify("a__b--c"), "a-b-c"); });',
  "",
].join("\n");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

/**
 * Build a network-free fixture cache: a bare "synthrepo.git" plus a task fixture
 * dir whose bug.patch is the clean -> bugged diff.
 */
async function makeSyntheticFixture(parent: string): Promise<string> {
  const clean = join(parent, "clean");
  await mkdir(join(clean, "test"), { recursive: true });
  await writeFile(join(clean, "lib.mjs"), CLEAN);
  await writeFile(join(clean, "test/visible.test.mjs"), VISIBLE);
  await writeFile(join(clean, "package.json"), JSON.stringify({ name: "synth-gym", type: "module" }));
  await git(clean, "init", "-q");
  await git(clean, "config", "user.email", "t@example.com");
  await git(clean, "config", "user.name", "tester");
  await git(clean, "add", "-A");
  await git(clean, "commit", "-q", "-m", "clean");
  const commit = (await git(clean, "rev-parse", "HEAD")).trim();

  await writeFile(join(clean, "lib.mjs"), BUGGED);
  const mutationPatch = await git(clean, "diff");
  await git(clean, "checkout", "--", "lib.mjs");

  const cacheRoot = join(parent, "cache");
  await mkdir(cacheRoot, { recursive: true });
  await execFileAsync("git", ["clone", "--bare", "-q", clean, join(cacheRoot, "synthrepo.git")]);

  const taskDir = join(parent, "fixture");
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "task.json"), JSON.stringify({
    repo: "synthrepo",
    commit,
    slug: "case",
    seed: 7,
    visibleTestPath: "test/visible.test.mjs",
    hiddenTestPath: "hidden.test.mjs",
  }));
  await writeFile(join(taskDir, "bug.patch"), mutationPatch);
  await writeFile(join(taskDir, "visible.test.mjs"), VISIBLE);
  await writeFile(join(taskDir, "hidden.test.mjs"), HIDDEN);
  await writeFile(join(taskDir, "hidden.cases.json"), JSON.stringify({
    cases: [
      { module: "./lib.mjs", call: "slugify", args: [""], expect: "", label: "empty" },
      { module: "./lib.mjs", call: "slugify", args: ["  A  B "], expect: "a-b", label: "spacing" },
      { module: "./lib.mjs", call: "slugify", args: ["a__b--c"], expect: "a-b-c", label: "repeats" },
    ],
  }));
  return taskDir;
}

test("materialize commits the bug: hidden fails, empty patch fails, golden passes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-task-"));
  try {
    const taskDir = await makeSyntheticFixture(parent);
    const task = await loadGymTask(taskDir);
    const work = join(parent, "work");
    const materialized = await materializeGymTask({ task, workDir: work, fixtureCacheDir: join(parent, "cache") });

    // The checkout really is the bugged state, committed.
    assert.equal(await readFile(join(materialized.repoDir, "lib.mjs"), "utf8"), BUGGED);
    assert.notEqual(materialized.bugCommit, materialized.baseCommit);

    if (!task.hiddenCases) throw new Error("fixture must carry held-out cases for the isolated scorer");
    // An empty patch must NOT pass: this is the baseRepoDir trap.
    const empty = await isolatedScoreGymPatch({ patchText: "", baseRepoDir: materialized.baseRepoDir, cases: task.hiddenCases });
    assert.notEqual(empty.outcome, "passed", `empty patch must not pass, got ${empty.outcome}`);

    // The bug's own reverse patch is the fix and must score passed.
    const golden = await goldenReversePatch(materialized.baseRepoDir, task.mutationPatch);
    const goldScore = await isolatedScoreGymPatch({ patchText: golden, baseRepoDir: materialized.baseRepoDir, cases: task.hiddenCases });
    assert.equal(goldScore.outcome, "passed", `golden scored ${goldScore.outcome}: ${goldScore.detail}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the checked-in he task fixture loads and its golden patch passes when the cache is warm", async (t) => {
  const fixtureDir = join(process.cwd(), "test/fixtures/gym-tasks/he/hex-decode");
  try {
    await access(join(DEFAULT_GYM_FIXTURE_CACHE_DIR, "he.git", "HEAD"), constants.R_OK);
  } catch {
    t.skip(`he fixture cache is cold at ${DEFAULT_GYM_FIXTURE_CACHE_DIR}; skipping (never reported as pass)`);
    return;
  }
  const parent = await mkdtemp(join(tmpdir(), "gym-he-"));
  try {
    const task = await loadGymTask(fixtureDir);
    assert.equal(task.repo, "he");
    let materialized;
    try {
      materialized = await materializeGymTask({ task, workDir: parent, repoDirName: "bugged" });
    } catch (error) {
      if (error instanceof GymFixtureUnavailableError) {
        t.skip(String(error.message));
        return;
      }
      throw error;
    }
    const source = await readFile(join(materialized.repoDir, "he.js"), "utf8");
    assert.ok(source.includes("parseInt(hexDigits, 10)"), "materialized checkout must contain the planted bug");
    assert.ok(!source.includes("parseInt(hexDigits, 16)"), "clean upstream code must not be present");

    if (!task.hiddenCases) throw new Error("he fixture must carry held-out cases for the isolated scorer");
    const empty = await isolatedScoreGymPatch({ patchText: "", baseRepoDir: materialized.baseRepoDir, cases: task.hiddenCases });
    assert.notEqual(empty.outcome, "passed", `hidden cases must fail on the freshly materialized bug: got ${empty.outcome}`);

    const golden = await goldenReversePatch(materialized.baseRepoDir, task.mutationPatch);
    const goldScore = await isolatedScoreGymPatch({ patchText: golden, baseRepoDir: materialized.baseRepoDir, cases: task.hiddenCases });
    assert.equal(goldScore.outcome, "passed", `golden scored ${goldScore.outcome}: ${goldScore.detail}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
