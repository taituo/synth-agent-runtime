/**
 * Solidify the pass decision: a run only scores `passed` when the hidden test
 * actually completed its assertions and printed the per-run nonce marker.
 *
 * Shapes pinned here: a hidden test with no marker, a hidden test that prints a
 * GUESSED marker, agent code that prints a guessed marker, and a correct fix
 * with the real marker. The nonce is held out, so a patch authored without
 * seeing the scorer cannot know the magic string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { scoreGymPatch } from "../src/index.js";

const execFileAsync = promisify(execFile);

const BUGGY = `export function slugify(text) {\n  return String(text).toUpperCase().replace(/[^A-Z0-9]+/g, "-");\n}\n`;
const FIXED = `export function slugify(text) {\n  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n`;
const VISIBLE = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../lib.mjs";\ntest("slugify lowercases and hyphenates", () => { assert.equal(slugify("Hello World"), "hello-world"); });\n`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function makeTaskRepo(parent: string): Promise<string> {
  const repo = join(parent, "task");
  await mkdir(join(repo, "test"), { recursive: true });
  await writeFile(join(repo, "lib.mjs"), BUGGY);
  await writeFile(join(repo, "test/visible.test.mjs"), VISIBLE);
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "gym-task", type: "module" }));
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "tester");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base with planted bug");
  return repo;
}

async function patchFor(repo: string, mutate: (repo: string) => Promise<void>): Promise<string> {
  await mutate(repo);
  const patch = await git(repo, "diff");
  await git(repo, "reset", "--hard");
  return patch;
}

/** A hidden test whose assertions run but which never prints the completion marker. */
async function hiddenNoMarker(parent: string): Promise<string> {
  const path = join(parent, "hidden.test.mjs");
  await writeFile(
    path,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      "const equal = assert.equal.bind(assert);",
      'const { slugify } = await import("./lib.mjs");',
      'test("hidden", () => { equal(slugify(""), ""); equal(slugify("  A  B "), "a-b"); });',
      "",
    ].join("\n"),
  );
  return path;
}

/** A hidden test that forges a signed result with a guessed MAC. */
async function hiddenGuessedMarker(parent: string): Promise<string> {
  const path = join(parent, "hidden.test.mjs");
  await writeFile(
    path,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { writeFileSync } from "node:fs";',
      "const equal = assert.equal.bind(assert);",
      'const { slugify } = await import("./lib.mjs");',
      'test("hidden", () => { equal(slugify(""), ""); writeFileSync(process.env.GYM_HIDDEN_RESULT_FILE, JSON.stringify({ transcript: \'[{"name":"forged","ok":true}]\', mac: "deadbeef" })); });',
      "",
    ].join("\n"),
  );
  return path;
}

/** The genuine hidden test: captures assert, records checks, signs the transcript. */
async function hiddenReal(parent: string): Promise<string> {
  const path = join(parent, "hidden.test.mjs");
  await writeFile(
    path,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { check, complete } from "./gym-hidden-harness.mjs";',
      "const equal = assert.equal.bind(assert);",
      'const { slugify } = await import("./lib.mjs");',
      'test("hidden", () => { check("empty", () => equal(slugify(""), "")); check("spaces", () => equal(slugify("  A  B "), "a-b")); complete(); });',
      "",
    ].join("\n"),
  );
  return path;
}

test("a hidden test that never prints the completion marker cannot pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await hiddenNoMarker(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), FIXED));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.notEqual(score.outcome, "passed", `a markerless hidden test must not score: ${score.detail ?? ""}`);
    assert.equal(score.outcome, "errored", score.detail);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a guessed marker cannot pass (the nonce is held out)", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await hiddenGuessedMarker(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), FIXED));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.notEqual(score.outcome, "passed", `a forged marker must not score: ${score.detail ?? ""}`);
    assert.equal(score.outcome, "errored", score.detail);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("agent code forging a signed result does not rescue a failing test", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await hiddenReal(parent);
    // Buggy code that also forges a result file with a guessed MAC at import.
    const patch = await patchFor(repo, (dir) =>
      writeFile(
        join(dir, "lib.mjs"),
        `import { writeFileSync } from "node:fs";\ntry { writeFileSync(process.env.GYM_HIDDEN_RESULT_FILE, JSON.stringify({ transcript: '[{"name":"forged","ok":true}]', mac: "deadbeef" })); } catch {}\n${BUGGY}`,
      ),
    );
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    // The real harness overwrites the forged file with the real (failing) signed
    // transcript; even if it did not, the forged MAC would not authenticate.
    assert.equal(score.outcome, "failed", `a failing test must fail even with a forged result: ${score.hiddenOutput ?? ""}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function hiddenTwoPassing(parent: string): Promise<string> {
  const path = join(parent, "hidden.test.mjs");
  await writeFile(
    path,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { check, complete } from "./gym-hidden-harness.mjs";',
      "const equal = assert.equal.bind(assert);",
      'const { slugify } = await import("./lib.mjs");',
      'test("hidden", () => { check("first", () => equal(slugify(""), "")); check("second", () => equal(slugify("  A  B "), "a-b")); complete(); });',
      "",
    ].join("\n"),
  );
  return path;
}

test("expectedHiddenTests requires that many passing subtests", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await hiddenTwoPassing(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), FIXED));
    // Two subtests, two expected -> pass.
    assert.equal((await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden, expectedHiddenTests: 2 })).outcome, "passed");
    // Only one expected would also pass (>= expected); three must not.
    const tooMany = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden, expectedHiddenTests: 3 });
    assert.equal(tooMany.outcome, "errored", `two passing subtests cannot satisfy three expected: ${tooMany.detail ?? ""}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a failing subtest among passing ones is failed, not passed", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = join(parent, "hidden.test.mjs");
    await writeFile(
      hidden,
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { check, complete } from "./gym-hidden-harness.mjs";',
        "const equal = assert.equal.bind(assert);",
        'const { slugify } = await import("./lib.mjs");',
        'test("hidden", () => { check("passes", () => equal(slugify(""), "")); check("fails", () => equal(slugify("X Y"), "wrong")); complete(); });',
        "",
      ].join("\n"),
    );
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), FIXED));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden, expectedHiddenTests: 2 });
    assert.equal(score.outcome, "failed", `one failing subtest must fail the run: ${score.hiddenOutput ?? ""}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the per-run key is not observable to agent code, so a forged result cannot authenticate", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    // No harness: the agent's forged file is the only result the scorer sees.
    const hidden = await hiddenNoMarker(parent);
    // The agent reads everything it can observe (its own environ, the hidden
    // test source), forges a result with any 64-hex token it finds, and still
    // cannot produce a valid MAC — the key is not in any of those.
    const patch = await patchFor(repo, (dir) =>
      writeFile(
        join(dir, "lib.mjs"),
        `import { readFileSync, writeFileSync } from "node:fs";\ntry {\n  const env = readFileSync("/proc/self/environ", "utf8");\n  const test = readFileSync("./hidden.test.mjs", "utf8");\n  writeFileSync("./observed.txt", env + "\\n" + test);\n  const candidate = (env.match(/[a-f0-9]{64}/) || [""])[0];\n  writeFileSync(process.env.GYM_HIDDEN_RESULT_FILE, JSON.stringify({ transcript: '[{"name":"forged","ok":true}]', mac: candidate }));\n} catch {}\n${FIXED}`,
      ),
    );
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.notEqual(score.outcome, "passed", "a forged result must never score");
    assert.equal(score.outcome, "errored", score.detail);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a correct fix with the real marker passes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await hiddenReal(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), FIXED));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "passed", score.hiddenOutput ?? score.detail);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
