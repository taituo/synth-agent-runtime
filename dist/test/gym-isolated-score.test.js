/**
 * The attempt loop wires the isolated scorer when the task ships held-out cases.
 *
 * The FORGE attacks (env nonce, early exit, assert mutation, harness
 * self-complete, filesystem/`/proc` vector reads, leaf symlink, openSync
 * symlink) live in one place: `test/gym-forge.test.ts`. This file keeps only the
 * loop-level test that a forged turn cannot make `runGymAttempt` certify a pass.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runGymAttempt, localEffectRunner } from "../src/index.js";
const execFileAsync = promisify(execFile);
const BUGGY = "export function addOne(n) {\n  return n;\n}\n";
const CASES = [
    { module: "./lib.mjs", call: "addOne", args: [1], expect: 2, label: "one" },
    { module: "./lib.mjs", call: "addOne", args: [0], expect: 1, label: "zero" },
    { module: "./lib.mjs", call: "addOne", args: [-1], expect: 0, label: "negative" },
];
async function git(cwd, ...args) {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
}
async function makeRepo(parent, lib = BUGGY) {
    const repo = join(parent, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "lib.mjs"), lib);
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "t@example.com");
    await git(repo, "config", "user.name", "tester");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "base");
    return repo;
}
test("runGymAttempt uses the isolated scorer when the task ships held-out cases", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
    try {
        const repo = await makeRepo(parent);
        const hiddenTestPath = join(parent, "hidden.test.mjs");
        await writeFile(hiddenTestPath, "// unused by the isolated path\n");
        const task = {
            repo: "synthetic",
            commit: "HEAD",
            slug: "case",
            seed: 1,
            visibleTestPath: "test/visible.test.mjs",
            hiddenTestPath,
            mutationPatch: "unused",
            taskDir: parent,
            hiddenCases: CASES,
        };
        const materialized = { task, repoDir: repo, baseRepoDir: repo, visibleTestPath: join(repo, "test/visible.test.mjs"), hiddenTestPath, bugCommit: "HEAD", baseCommit: "HEAD" };
        // A payload that would have forged the old scorer must not pass here.
        const forgeTurn = async () => ({
            toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: `process.exit(0);\n${BUGGY}` } }, { name: "finish" }],
        });
        const record = await runGymAttempt({ task: materialized, runner: localEffectRunner(repo), turn: forgeTurn, nodeBin: process.execPath });
        assert.notEqual(record.outcome, "passed", "the runner must not certify a forged patch");
        assert.equal(record.outcome, "errored");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
