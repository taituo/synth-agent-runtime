/**
 * Artifact-egress mechanism 2: git as the transport. A bundle round-trip (the
 * sandbox "push") must preserve what workspace sync flattens: symlinks
 * (mode 120000), executable bits (100755), unusual filenames, and the tree hash.
 * Uses real git, not a mock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ingestBundle, listTreeEntries, treeDigest } from "../src/index.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

test("a bundle round-trip preserves symlinks, executable bits, unusual names and the tree hash", async () => {
  const parent = await mkdtemp(join(tmpdir(), "git-transport-"));
  try {
    const src = join(parent, "src");
    await mkdir(src);
    await git(src, "init", "-q");
    await git(src, "config", "user.email", "t@example.com");
    await git(src, "config", "user.name", "tester");
    await writeFile(join(src, "regular.txt"), "hello\n");
    await symlink("regular.txt", join(src, "link.txt"));
    await writeFile(join(src, "script.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(src, "script.sh"), 0o755);
    await mkdir(join(src, "dir with space"));
    await writeFile(join(src, "dir with space", "naïve--name.txt"), "odd\n");
    await git(src, "add", "-A");
    await git(src, "commit", "-q", "-m", "base");
    const sourceTree = await git(src, "rev-parse", "HEAD^{tree}");

    // The sandbox emits this bundle on stdout; here it is created locally.
    const bundle = join(parent, "export.bundle");
    await git(src, "bundle", "create", bundle, "HEAD");

    const bare = join(parent, "bare.git");
    const commit = await ingestBundle(bundle, bare);
    assert.equal(await treeDigest(bare, commit), sourceTree, "tree hash matches git's exactly");

    const entries = await listTreeEntries(bare, commit);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("link.txt")?.mode, "120000", "symlink preserved as a link");
    assert.equal(byPath.get("script.sh")?.mode, "100755", "executable bit preserved");
    assert.ok(byPath.has("dir with space/naïve--name.txt"), "unusual filename survives");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
