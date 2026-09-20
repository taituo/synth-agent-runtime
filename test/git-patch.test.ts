/**
 * Artifact-egress mechanism 3: patch extraction. A `git diff` change proposal
 * must apply cleanly to the base it names, on a clean checkout, preserving
 * modes (symlink, executable) and unusual filenames. Real git, not a mock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyPatch, applyPatchCheck } from "../src/index.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

test("a patch applies cleanly to its base checkout, preserving modes and odd names", async () => {
  const parent = await mkdtemp(join(tmpdir(), "git-patch-"));
  try {
    const src = join(parent, "src");
    await mkdir(src);
    await git(src, "init", "-q");
    await git(src, "config", "user.email", "t@example.com");
    await git(src, "config", "user.name", "tester");
    await writeFile(join(src, "regular.txt"), "base\n");
    await git(src, "add", "-A");
    await git(src, "commit", "-q", "-m", "base");

    // The change proposal: modify, symlink, executable, unusual filename.
    await writeFile(join(src, "regular.txt"), "changed\n");
    await symlink("regular.txt", join(src, "link.txt"));
    await writeFile(join(src, "script.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(src, "script.sh"), 0o755);
    await mkdir(join(src, "dir with space"));
    await writeFile(join(src, "dir with space", "naïve--name.txt"), "odd\n");
    await git(src, "add", "-A");
    const patch = await git(src, "diff", "--cached");

    // A clean checkout at the base commit (no working-tree changes).
    const clean = join(parent, "clean");
    await git(parent, "clone", "-q", src, clean);
    await git(clean, "config", "user.email", "t@example.com");
    await git(clean, "config", "user.name", "tester");
    assert.equal(await applyPatchCheck(patch, clean), true, "patch applies cleanly to the base");
    await applyPatch(patch, clean);

    assert.equal(await readFile(join(clean, "regular.txt"), "utf8"), "changed\n");
    await git(clean, "add", "-A");
    const lsFiles = await git(clean, "-c", "core.quotePath=false", "ls-files", "-s");
    assert.ok(lsFiles.includes("120000") && lsFiles.includes("link.txt"), `symlink mode preserved: ${lsFiles}`);
    assert.ok(lsFiles.includes("100755") && lsFiles.includes("script.sh"), `executable preserved: ${lsFiles}`);
    assert.ok(lsFiles.includes("naïve--name.txt"), `unusual filename survives: ${lsFiles}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
