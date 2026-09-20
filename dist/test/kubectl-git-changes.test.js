/**
 * `listGitChanges` parses `git status -z` with a shell loop that uses
 * `read -d`, which is a bash/busybox-ash builtin. Debian's `/bin/sh` is dash and
 * rejects it, so under the repo's own `node:22-bookworm-slim` executor the loop
 * emitted nothing and `syncBack` silently imported zero changes — workspace
 * write-back broke with no error. (Found live: the gVisor `fault-rungs` and
 * `mixed-chain` proofs failed with the pinned repo image and passed with
 * alpine/git.)
 *
 * This test reproduces the failure mode and pins the fix: the loop run under a
 * POSIX-only shell emits nothing, while `gitChangesCommand()` detects a
 * `read -d`-capable shell and emits every change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_CHANGES_LOOP, GIT_CHANGES_LOOP_ENV, gitChangesCommand } from "../src/index.js";
function git(cwd, ...args) {
    execFileSync("git", args, { cwd, stdio: "ignore" });
}
/** True when `sh` supports `read -d` (bash or busybox ash), i.e. not dash. */
function shSupportsReadD() {
    const probe = spawnSync("sh", ["-c", "read -r -d '' v </dev/null"], { encoding: "utf8" });
    return !/Illegal option|not found|invalid option/i.test(probe.stderr);
}
function records(stdout) {
    const tokens = stdout.split("\0");
    const out = [];
    for (let i = 0; i + 3 < tokens.length; i += 4) {
        if (tokens[i])
            out.push(tokens[i]);
    }
    return out;
}
test("the git-change loop works under a dash outer shell (the repo executor's /bin/sh)", async (t) => {
    const repo = await mkdtemp(join(tmpdir(), "kubectl-gitchanges-"));
    try {
        git(repo, "init", "-q");
        git(repo, "config", "user.email", "t@example.com");
        git(repo, "config", "user.name", "tester");
        await writeFile(join(repo, "base.txt"), "base\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "base");
        await writeFile(join(repo, "new.txt"), "new\n");
        await mkdir(join(repo, "dir with space"), { recursive: true });
        await writeFile(join(repo, "dir with space", "naïve--name.txt"), "unicode\n");
        const env = { ...process.env, [GIT_CHANGES_LOOP_ENV]: GIT_CHANGES_LOOP };
        // The fixed command, run through the host's `/bin/sh` exactly as the pod
        // does. It must delegate the loop to a shell that supports `read -d`.
        const fixed = spawnSync("sh", ["-c", gitChangesCommand(repo)], { env, encoding: "utf8" });
        const fixedRecords = records(fixed.stdout);
        assert.deepEqual(fixedRecords.sort(), ["dir with space/naïve--name.txt", "new.txt"], `gitChangesCommand must report both changes; stdout=${JSON.stringify(fixed.stdout)} stderr=${fixed.stderr}`);
        // Discriminating control: the old shape (loop piped straight into the outer
        // `sh`) emits nothing when that shell is dash. If `sh` here supports
        // `read -d`, the control cannot differentiate, so skip rather than claim it.
        if (shSupportsReadD()) {
            t.diagnostic("host /bin/sh supports read -d; the old-shape control does not differentiate");
            return;
        }
        const oldStyle = spawnSync("sh", ["-c", `cd ${JSON.stringify(repo)} && git status --porcelain=v1 -z --untracked-files=all --no-renames | sh -c "$${GIT_CHANGES_LOOP_ENV}"`], { env, encoding: "utf8" });
        assert.equal(records(oldStyle.stdout).length, 0, `the un-delegated loop must emit nothing under dash; stdout=${JSON.stringify(oldStyle.stdout)} stderr=${JSON.stringify(oldStyle.stderr)}`);
        assert.match(oldStyle.stderr, /Illegal option|read: /, "dash must reject read -d");
    }
    finally {
        await rm(repo, { recursive: true, force: true });
    }
});
