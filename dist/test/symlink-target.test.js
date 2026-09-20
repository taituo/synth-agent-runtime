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
import { MemoryWorkspace, NativeGitSource, SyntheticExecutor, escapesWorkspace, resolveSymlinkTarget } from "../src/index.js";
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
    assert.equal(result.resolved, "tests/fixtures/other-dir/pm");
});
test("absolute targets and targets that climb past the root are rejected", () => {
    assert.deepEqual(resolveSymlinkTarget("a/b/link", "/etc/passwd"), { ok: false, reason: "escapes", linkPath: "a/b/link", target: "/etc/passwd" });
    assert.equal(resolveSymlinkTarget("a/b/link", "../../../../etc/passwd").ok, false);
    assert.equal(resolveSymlinkTarget("link", "../outside").ok, false);
    assert.equal(resolveSymlinkTarget("a/b/link", "C:\\windows\\system32").ok, false);
});
test("a chain is followed with a depth limit, and cycles are rejected", () => {
    const links = { "a": "b", "b": "c", "c": "d" };
    const readLink = (path) => links[path];
    assert.equal(resolveSymlinkTarget("a", "b", readLink).resolved, "d", "follows a->b->c->d");
    const cycle = { "a": "b", "b": "a" };
    assert.equal(resolveSymlinkTarget("a", "b", (p) => cycle[p]).ok, false);
    assert.equal(resolveSymlinkTarget("a", "b", (p) => cycle[p]).reason, "cycle");
    // A chain longer than the limit is too-deep, not silently accepted.
    const long = {};
    for (let i = 0; i < 40; i++)
        long[`n${i}`] = `n${i + 1}`;
    const deep = resolveSymlinkTarget("n0", "n1", (p) => long[p], { maxDepth: 5 });
    assert.equal(deep.reason, "too-deep");
});
test("a symlinked intermediate directory that escapes is rejected", () => {
    // `d` is a symlink out of the workspace; `d/secret.txt` escapes even though
    // the leaf `secret.txt` is not itself a link.
    const outside = (p) => (p === "d" ? "../outside" : undefined);
    const result = resolveSymlinkTarget("link", "d/secret.txt", outside);
    assert.equal(result.ok, false, "an intermediate symlinked dir that escapes must be rejected");
    assert.equal(result.reason, "escapes");
    // An in-workspace intermediate symlinked directory is followed.
    const inside = (p) => (p === "d" ? "sub" : undefined);
    const followed = resolveSymlinkTarget("link", "d/secret.txt", inside);
    assert.equal(followed.ok, true);
    assert.equal(followed.resolved, "sub/secret.txt");
});
test("a dangling link is a valid link and is kept, not resolved-and-failed", () => {
    const result = resolveSymlinkTarget("a/link", "../missing/target", () => undefined);
    assert.equal(result.ok, true);
    assert.equal(result.resolved, "missing/target");
});
test("MemoryWorkspace.symlink puts the containment policy in force (the caller)", async () => {
    const workspace = new MemoryWorkspace();
    workspace.write("target.txt", "content");
    workspace.symlink("link.txt", "target.txt");
    assert.equal((await workspace.stat("link.txt"))?.kind, "symlink");
    assert.equal(new TextDecoder().decode(await workspace.read("link.txt")), "content", "read follows the link");
    // An in-workspace symlinked directory is followed.
    workspace.write("sub/secret.txt", "s");
    workspace.symlink("d", "sub");
    workspace.symlink("link2", "d/secret.txt");
    assert.equal(new TextDecoder().decode(await workspace.read("link2")), "s");
    // Escaping targets are rejected at creation, so no escaping link can exist.
    assert.throws(() => workspace.symlink("bad", "/etc/passwd"), /WORKSPACE_PATH_ESCAPES/);
    assert.throws(() => workspace.symlink("bad2", "../outside"), /WORKSPACE_PATH_ESCAPES/);
    assert.throws(() => workspace.symlink("d2", "../outside"), /WORKSPACE_PATH_ESCAPES/);
});
test("the workspace.symlink effect enforces containment through the executor", async () => {
    const workspace = new MemoryWorkspace();
    const executor = new SyntheticExecutor(new Map([[workspace.id, workspace]]));
    const ctx = { agentId: "a", workspaceId: workspace.id };
    await executor.execute({ id: "w", kind: "workspace.write", path: "target.txt", content: "c" }, ctx);
    assert.equal((await executor.execute({ id: "s", kind: "workspace.symlink", path: "link.txt", target: "target.txt" }, ctx)).ok, true);
    const bad = await executor.execute({ id: "b", kind: "workspace.symlink", path: "bad", target: "/etc/passwd" }, ctx);
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /WORKSPACE_PATH_ESCAPES/);
});
test("verified against the real pinned commander fixture", async (t) => {
    const repo = REAL_REPOS.find((entry) => entry.name === "commander");
    let cache;
    try {
        cache = await repoCachePath(repo);
    }
    catch (error) {
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
        const resolved = result.resolved;
        assert.equal(resolved, "tests/fixtures/other-dir/pm");
        // The resolved path really exists in the repo.
        assert.ok(await source.stat(resolved), "resolved target exists");
        // The same link with an escaping target is rejected.
        assert.equal(resolveSymlinkTarget(link, "../../../../etc/passwd").ok, false);
    }
    finally {
        await source.close();
        await rm(parent, { recursive: true, force: true });
    }
});
