/**
 * Scoped push grants: a sandbox credential can create exactly one granted ref,
 * once, and nothing else. Exercised against real git and a real pre-receive
 * hook — the authorization is the hook plus the grant, not a promise.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createScopedPushGrant, scopedPush } from "../src/index.js";
const execFileAsync = promisify(execFile);
async function git(cwd, ...args) {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
}
async function setup() {
    const parent = await mkdtemp(join(tmpdir(), "scoped-push-"));
    const bare = join(parent, "bare.git");
    const work = join(parent, "work");
    await git(parent, "init", "--bare", "-q", bare);
    await git(parent, "init", "-q", work);
    await git(work, "config", "user.email", "t@example.com");
    await git(work, "config", "user.name", "tester");
    await writeFile(join(work, "a.txt"), "hello\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "-m", "first");
    return { parent, bare, work };
}
test("a grant allows exactly one new ref, once", async () => {
    const { parent, bare, work } = await setup();
    try {
        const ref = "refs/synth/agent1/run1";
        await createScopedPushGrant({ repoDir: bare, ref });
        const first = await scopedPush({ workDir: work, remote: bare, localRef: "HEAD", ref });
        assert.equal(first.ok, true, first.stderr);
        assert.equal((await git(bare, "rev-parse", "--verify", ref)).trim().length, 40);
        // One-shot: the same grant cannot be replayed.
        const replay = await scopedPush({ workDir: work, remote: bare, localRef: "HEAD", ref: "refs/synth/agent1/run1b" });
        assert.equal(replay.ok, false, "a second push must be rejected");
        assert.match(replay.stderr, /SYNTH_PUSH_REJECTED/);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a push to any ref other than the granted one is rejected", async () => {
    const { parent, bare, work } = await setup();
    try {
        await createScopedPushGrant({ repoDir: bare, ref: "refs/synth/agent1/run1" });
        const other = await scopedPush({ workDir: work, remote: bare, localRef: "HEAD", ref: "refs/heads/main" });
        assert.equal(other.ok, false);
        assert.match(other.stderr, /no valid grant/);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("an expired grant is rejected, and a delete is rejected", async () => {
    const { parent, bare, work } = await setup();
    try {
        await createScopedPushGrant({ repoDir: bare, ref: "refs/synth/agent1/expired", ttlMs: -1 });
        const expired = await scopedPush({ workDir: work, remote: bare, localRef: "HEAD", ref: "refs/synth/agent1/expired" });
        assert.equal(expired.ok, false);
        assert.match(expired.stderr, /no valid grant/);
        const live = "refs/synth/agent1/live";
        await createScopedPushGrant({ repoDir: bare, ref: live });
        assert.equal((await scopedPush({ workDir: work, remote: bare, localRef: "HEAD", ref: live })).ok, true);
        await createScopedPushGrant({ repoDir: bare, ref: live });
        const del = await scopedPush({ workDir: work, remote: bare, localRef: "", ref: live });
        assert.equal(del.ok, false);
        assert.match(del.stderr, /deleting a ref is not allowed/);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
