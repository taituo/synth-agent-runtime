/**
 * Track 1: real public repositories as workspace fixtures.
 *
 * Proves `NativeGitSource` clones a real repo at a pinned SHA, exposes exactly
 * the repo's tree, hydrates blob bytes identical to git's, preserves symlinks,
 * and is idempotent. Uses a warm local cache (see fixtures/real-repos.ts), so
 * it never depends on the network; a cold+offline cache SKIPs.
 *
 * NOT covered here (reported honestly): submodules, LFS/binary-heavy repos and
 * repos with unusual filenames — no suitably small public repo was found and
 * verified in the time available; unusual names are covered synthetically in
 * the Track 3 generators instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeGitSource } from "../src/index.js";
import { FixtureUnavailableError, REAL_REPOS, blobBytes, listTreeFiles, repoCachePath, } from "./fixtures/real-repos.js";
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
async function withSource(cache, repo, fn) {
    // NativeGitSource inits gitDir itself, so it must not exist yet.
    const parent = await mkdtemp(join(tmpdir(), `synth-t1-${repo.name}-`));
    const gitDir = join(parent, "cache.git");
    const source = await NativeGitSource.open({ gitDir, remote: cache, ref: repo.commit });
    try {
        return await fn(source);
    }
    finally {
        await source.close();
        await rm(parent, { recursive: true, force: true });
    }
}
test("every pinned repo exposes exactly its tree at the pinned commit", async (t) => {
    for (const repo of REAL_REPOS) {
        const cache = await cacheOrSkip(t, repo);
        if (!cache)
            return;
        await withSource(cache, repo, async (source) => {
            const revision = await source.revision();
            assert.equal(revision.commit, repo.commit, `${repo.name}: checked out the pinned SHA`);
            const listed = [];
            for await (const path of source.listFiles())
                listed.push(path);
            assert.deepEqual(listed.sort(), (await listTreeFiles(cache, repo.commit)).sort(), `${repo.name}: file list matches git`);
        });
    }
});
test("hydrated blob bytes are identical to git's for a full real tree", async (t) => {
    const repo = REAL_REPOS.find((entry) => entry.name === "he");
    const cache = await cacheOrSkip(t, repo);
    if (!cache)
        return;
    await withSource(cache, repo, async (source) => {
        const files = await listTreeFiles(cache, repo.commit);
        for (const path of files) {
            const hydrated = Buffer.from(await source.readFile(path));
            const expected = await blobBytes(cache, repo.commit, path);
            assert.equal(hydrated.equals(expected), true, `${path}: bytes match git (${hydrated.length} bytes)`);
        }
        assert.ok(files.length >= 30, "a real repo, not a stub");
    });
});
test("symlinks survive: stat reports them and hydration returns the link target", async (t) => {
    const repo = REAL_REPOS.find((entry) => entry.name === "commander");
    const cache = await cacheOrSkip(t, repo);
    if (!cache)
        return;
    await withSource(cache, repo, async (source) => {
        const link = "tests/fixtures/pmlink";
        const info = await source.stat(link);
        assert.equal(info?.kind, "symlink", `${link} is a symlink, not a regular file`);
        const target = Buffer.from(await source.readFile(link)).toString("utf8");
        assert.equal(target, Buffer.from(await blobBytes(cache, repo.commit, link)).toString("utf8"));
        assert.ok(target.length > 0 && target.length < 200, "link target looks like a path");
    });
});
test("opening the same pinned revision twice is idempotent", async (t) => {
    const repo = REAL_REPOS.find((entry) => entry.name === "he");
    const cache = await cacheOrSkip(t, repo);
    if (!cache)
        return;
    const first = await withSource(cache, repo, async (source) => {
        const revision = await source.revision();
        const files = [];
        for await (const path of source.listFiles())
            files.push(path);
        return { revision, files: files.sort() };
    });
    const second = await withSource(cache, repo, async (source) => {
        const revision = await source.revision();
        const files = [];
        for await (const path of source.listFiles())
            files.push(path);
        return { revision, files: files.sort() };
    });
    assert.deepEqual(second, first, "a second open yields the same revision and file list");
});
test("a cold cache with an unreachable remote raises FixtureUnavailableError (skip path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-t1-cold-"));
    const previous = process.env.SYNTH_FIXTURE_REPOS;
    process.env.SYNTH_FIXTURE_REPOS = dir;
    try {
        await assert.rejects(() => repoCachePath({ name: "missing", url: join(dir, "does-not-exist"), commit: "0".repeat(40), license: "n/a" }), (error) => {
            assert.ok(error instanceof FixtureUnavailableError, "must be a skippable fixture error");
            assert.match(error.message, /cache is cold and clone failed/);
            return true;
        });
    }
    finally {
        if (previous === undefined)
            delete process.env.SYNTH_FIXTURE_REPOS;
        else
            process.env.SYNTH_FIXTURE_REPOS = previous;
        await rm(dir, { recursive: true, force: true });
    }
});
