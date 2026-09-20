/**
 * Step 3: harvest the patch from git, not from the workspace mirror. Side
 * effects such as `node_modules` must never travel with the scored patch, while
 * genuine new source files must.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { harvestPatch, localEffectRunner, parsePatchPaths } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function makeRepo(parent: string): Promise<string> {
  const repo = join(parent, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "lib.mjs"), "export const value = 1;\n");
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "tester");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  return repo;
}

test("harvest includes source changes and new files but excludes node_modules", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-harvest-"));
  try {
    const repo = await makeRepo(parent);
    const runner = localEffectRunner(repo);

    await writeFile(join(repo, "lib.mjs"), "export const value = 2;\n");
    await writeFile(join(repo, "new-source.mjs"), "export const added = true;\n");
    await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
    await writeFile(join(repo, "node_modules", "dep", "index.js"), "module.exports = {};\n");

    const patch = await harvestPatch(runner, { repoDir: repo });
    assert.match(patch, /value = 2/, "the source change must be in the patch");
    assert.match(patch, /added = true/, "a genuine new source file must be in the patch");

    const paths = parsePatchPaths(patch);
    assert.ok(!paths.some((path) => path.includes("node_modules")), `node_modules leaked into the patch: ${paths.join(", ")}`);
    assert.ok(!patch.includes("node_modules/dep/index.js"), "the sandbox-only node_modules entry must not travel with the patch");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("harvest of an untouched repo is empty", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-harvest-"));
  try {
    const repo = await makeRepo(parent);
    const patch = await harvestPatch(localEffectRunner(repo), { repoDir: repo });
    assert.equal(patch.trim(), "");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
