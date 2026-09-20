/**
 * Gym scoring + anti-cheat. The score comes from applying the agent's patch to
 * a fresh checkout and running a held-out test; tampering is a distinct outcome
 * from failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parsePatchPaths, scoreGymPatch } from "../src/index.js";

const execFileAsync = promisify(execFile);

const BUGGY = `export function slugify(text) {\n  return String(text).toUpperCase().replace(/[^A-Z0-9]+/g, "-");\n}\n`;
const FIXED = `export function slugify(text) {\n  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n`;
const VISIBLE = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../lib.mjs";\ntest("slugify lowercases and hyphenates", () => { assert.equal(slugify("Hello World"), "hello-world"); });\n`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

/** A pinned base checkout with the planted bug and the visible (read-only) test. */
async function makeTaskRepo(parent: string, lib = BUGGY): Promise<string> {
  const repo = join(parent, "task");
  await mkdir(join(repo, "test"), { recursive: true });
  await writeFile(join(repo, "lib.mjs"), lib);
  await writeFile(join(repo, "test/visible.test.mjs"), VISIBLE);
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "gym-task", type: "module" }));
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "tester");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base with planted bug");
  return repo;
}

/**
 * Hidden test the agent never sees: cases the visible test does not cover.
 * It captures the real assert before dynamically importing the agent's module,
 * so an agent that replaces `assert.equal` cannot win; and it never lets an
 * agent top-level `process.exit` look like a pass (no TAP summary -> not passed).
 */
async function makeHiddenTest(parent: string, sleepMs = 0): Promise<string> {
  const path = join(parent, "hidden.test.mjs");
  await writeFile(
    path,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      "const equal = assert.equal.bind(assert);",
      'const { slugify } = await import("./lib.mjs");',
      `test("hidden", async () => {${sleepMs ? ` await new Promise((r) => setTimeout(r, ${sleepMs}));` : ""} equal(slugify(""), ""); equal(slugify("  A  B "), "a-b"); equal(slugify("a__b--c"), "a-b-c"); console.log("GYM_HIDDEN_COMPLETE " + process.env.GYM_HIDDEN_NONCE); });`,
      "",
    ].join("\n"),
  );
  return path;
}

/** A hidden test that declares tests but runs none of them. */
async function makeEmptyHiddenTest(parent: string): Promise<string> {
  const path = join(parent, "hidden.test.mjs");
  await writeFile(path, 'import test from "node:test";\n');
  return path;
}

async function makeSkippedHiddenTest(parent: string): Promise<string> {
  const path = join(parent, "hidden.test.mjs");
  await writeFile(
    path,
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("hidden", { skip: true }, () => { assert.equal(1, 2); });\n',
  );
  return path;
}

/** Produce a patch by mutating the repo, diffing, then resetting. */
async function patchFor(repo: string, mutate: (repo: string) => Promise<void>): Promise<string> {
  await mutate(repo);
  const patch = await git(repo, "diff");
  await git(repo, "reset", "--hard");
  return patch;
}

test("a correct fix passes the held-out test", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), FIXED));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "passed", score.hiddenOutput);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a wrong fix fails the held-out test", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), `${BUGGY}// touched\n`));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "failed", `got ${score.outcome}: ${score.hiddenOutput ?? score.detail}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a constant stub passes the visible test but fails the held-out test", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), 'export function slugify() { return "hello-world"; }\n'));
    // The visible test would pass; the hidden test (empty, repeats, spacing) fails.
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "failed", "a constant-returning stub must not score");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a patch that exits 0 at import without fixing the bug does not pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    // Runs before the hidden assertions, and exits the test process cleanly.
    const patch = await patchFor(repo, (dir) =>
      writeFile(join(dir, "lib.mjs"), `process.exit(0);\nexport function slugify(text) {\n  return String(text).toUpperCase().replace(/[^A-Z0-9]+/g, "-");\n}\n`),
    );
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.notEqual(score.outcome, "passed", `exit(0) must never score: ${score.detail ?? score.hiddenOutput ?? ""}`);
    assert.equal(score.outcome, "errored", score.detail);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a patch that monkeypatches assert does not pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    const patch = await patchFor(repo, (dir) =>
      writeFile(
        join(dir, "lib.mjs"),
        `import assert from "node:assert/strict";\nassert.equal = () => {};\nexport function slugify(text) {\n  return String(text).toUpperCase().replace(/[^A-Z0-9]+/g, "-");\n}\n`,
      ),
    );
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.notEqual(score.outcome, "passed", `assert patching must never score: ${score.detail ?? score.hiddenOutput ?? ""}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a hidden test that runs no assertions is skipped, not passed", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeEmptyHiddenTest(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), FIXED));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.notEqual(score.outcome, "passed", `an empty hidden test must never score: ${score.detail ?? ""}`);
    // node --test marks a file with no tests as one passing subtest; the missing
    // completion marker is what keeps that from being a pass.
    assert.equal(score.outcome, "errored", score.detail);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("an all-skipped hidden test is skipped, not passed", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeSkippedHiddenTest(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), FIXED));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "skipped", score.detail);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a patch that plants files under the hidden-test path is tampering, not a crash", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    await mkdir(join(repo, "hidden.test.mjs"), { recursive: true });
    await writeFile(join(repo, "hidden.test.mjs/decoy.txt"), "not the hidden test\n");
    await git(repo, "add", "-A");
    const patch = await git(repo, "diff", "--cached");
    await git(repo, "reset", "--hard");
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "tampered", `got ${score.outcome}: ${score.detail ?? ""}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("deleting the visible test is tampering, not failure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    const patch = await patchFor(repo, async (dir) => {
      await rm(join(dir, "test/visible.test.mjs"));
    });
    assert.ok(parsePatchPaths(patch).includes("test/visible.test.mjs"));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "tampered");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("editing the runner config is tampering", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "package.json"), JSON.stringify({ name: "gym-task", type: "module", scripts: { test: "true" } })));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "tampered");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a patch with no diff --git header that edits the visible test is tampering", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    const full = await patchFor(repo, (dir) => writeFile(join(dir, "test/visible.test.mjs"), `${VISIBLE}// tampered\n`));
    // A hand-crafted patch can omit the diff --git header and still apply; the
    // tampering check must not depend on that header being present.
    const noHeader = full
      .split("\n")
      .filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index "))
      .join("\n");
    const score = await scoreGymPatch({ patchText: noHeader, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "tampered", `got ${score.outcome}: ${score.detail ?? score.hiddenOutput}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("renaming the visible test away is tampering, not a clean delete", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    await git(repo, "mv", "test/visible.test.mjs", "notes.txt");
    const patch = await git(repo, "diff", "--cached", "-M");
    await git(repo, "reset", "--hard");
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "tampered", `got ${score.outcome}: ${score.detail ?? score.hiddenOutput}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a quoted non-ASCII path under test/ is still tampering", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    await writeFile(join(repo, "test/café.test.mjs"), "// extra\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add unicode test");
    const hidden = await makeHiddenTest(parent);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "test/café.test.mjs"), "// tampered\n"));
    assert.ok(patch.includes('"a/test/caf'), "expected git to quote the non-ASCII path");
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "tampered", `got ${score.outcome}: ${score.detail ?? score.hiddenOutput}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a patch that does not apply is errored", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent);
    const score = await scoreGymPatch({ patchText: "this is not a patch", baseRepoDir: repo, hiddenTestPath: hidden });
    assert.equal(score.outcome, "errored");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a hidden test that outlives the timeout is timed-out", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-"));
  try {
    const repo = await makeTaskRepo(parent);
    const hidden = await makeHiddenTest(parent, 5_000);
    const patch = await patchFor(repo, (dir) => writeFile(join(dir, "lib.mjs"), FIXED));
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, hiddenTestPath: hidden, timeoutMs: 500 });
    assert.equal(score.outcome, "timed-out", `got ${score.outcome}: ${score.hiddenOutput ?? score.detail}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
