/**
 * Symlink target resolution policy (review follow-up 3).
 *
 * The check must run on the RESOLVED path, not the raw target: a target is
 * resolved relative to the link's own parent first. Verified against the pinned
 * commander fixture (`tests/fixtures/another-dir/pm` -> `../other-dir/pm`,
 * which resolves INSIDE and must be kept) as well as invented escape cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeGitSource, escapesWorkspace, resolveSymlinkTarget } from "../src/index.js";
import { FixtureUnavailableError, REAL_REPOS, repoCachePath } from "./fixtures/real-repos.js";

test("regression: the raw-target check is wrong for relative in-repo links", () => {
  // `escapesWorkspace` inspects the raw target, so it rejects a real in-repo
  // symlink. Resolution must happen first; the check is on the resolved path.
  assert.equal(escapesWorkspace("../other-dir/pm"), true, "raw check wrongly rejects a real in-repo link");
  assert.equal(resolveSymlinkTarget("tests/fixtures/another-dir/pm", "../other-dir/pm").ok, true, "resolved check keeps it");
});

test("a relative target that stays inside is kept (resolved against the link's parent)", () => {
  const result = resolveSymlinkTarget("tests/fixtures/another-dir/pm", "../other-dir/pm");
  assert.equal(result.ok, true);
  assert.equal((result as { resolved: string }).resolved, "tests/fixtures/other-dir/pm");
});

test("absolute targets and targets that climb past the root are rejected", () => {
  assert.deepEqual(resolveSymlinkTarget("a/b/link", "/etc/passwd"), { ok: false, reason: "escapes", linkPath: "a/b/link", target: "/etc/passwd" });
  assert.equal(resolveSymlinkTarget("a/b/link", "../../../../etc/passwd").ok, false);
  assert.equal(resolveSymlinkTarget("link", "../outside").ok, false);
  assert.equal(resolveSymlinkTarget("a/b/link", "C:\\windows\\system32").ok, false);
});

test("a chain is followed with a depth limit, and cycles are rejected", () => {
  const links: Record<string, string> = { "a": "b", "b": "c", "c": "d" };
  const readLink = (path: string) => links[path];
  assert.equal((resolveSymlinkTarget("a", "b", readLink) as { resolved?: string }).resolved, "d", "follows a->b->c->d");
  const cycle: Record<string, string> = { "a": "b", "b": "a" };
  assert.equal(resolveSymlinkTarget("a", "b", (p) => cycle[p]).ok, false);
  assert.equal((resolveSymlinkTarget("a", "b", (p) => cycle[p]) as { reason?: string }).reason, "cycle");
  // A chain longer than the limit is too-deep, not silently accepted.
  const long: Record<string, string> = {};
  for (let i = 0; i < 40; i++) long[`n${i}`] = `n${i + 1}`;
  const deep = resolveSymlinkTarget("n0", "n1", (p) => long[p], { maxDepth: 5 });
  assert.equal((deep as { reason?: string }).reason, "too-deep");
});

test("a dangling link is a valid link and is kept, not resolved-and-failed", () => {
  const result = resolveSymlinkTarget("a/link", "../missing/target", () => undefined);
  assert.equal(result.ok, true);
  assert.equal((result as { resolved: string }).resolved, "missing/target");
});

test("verified against the real pinned commander fixture", async (t) => {
  const repo = REAL_REPOS.find((entry) => entry.name === "commander")!;
  let cache: string;
  try {
    cache = await repoCachePath(repo);
  } catch (error) {
    if (error instanceof FixtureUnavailableError) {
      t.skip(error.message);
      return;
    }
    throw error;
  }
  const parent = await mkdtemp(join(tmpdir(), "synth-symtarget-"));
  const source = await NativeGitSource.open({ gitDir: join(parent, "cache.git"), remote: cache, ref: repo.commit });
  try {
    const link = "tests/fixtures/another-dir/pm";
    assert.equal((await source.stat(link))?.kind, "symlink");
    const target = new TextDecoder().decode(await source.readFile(link));
    assert.equal(target, "../other-dir/pm", "the real fixture target");

    const result = resolveSymlinkTarget(link, target);
    assert.equal(result.ok, true, "a real in-repo symlink must be kept");
    const resolved = (result as { resolved: string }).resolved;
    assert.equal(resolved, "tests/fixtures/other-dir/pm");
    // The resolved path really exists in the repo.
    assert.ok(await source.stat(resolved), "resolved target exists");

    // The same link with an escaping target is rejected.
    assert.equal(resolveSymlinkTarget(link, "../../../../etc/passwd").ok, false);
  } finally {
    await source.close();
    await rm(parent, { recursive: true, force: true });
  }
});
