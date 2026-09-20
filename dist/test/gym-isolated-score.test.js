/**
 * Regression tests for the fifth-round scorer forgeries. These are the exact
 * attacks that scored `passed` with the bug unfixed against the old in-process
 * scorer; the isolated scorer must NOT pass them.
 *
 *   - agent code reads GYM_HIDDEN_NONCE from its own environment;
 *   - agent code calls process.exit(0) before assertions run (early exit);
 *   - agent code mutates the assertion library (irrelevant now, but pinned).
 *
 * Also pins the vacuity defect: zero cases and a skip are never `passed`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isolatedScoreGymPatch, runGymAttempt, localEffectRunner } from "../src/index.js";
const execFileAsync = promisify(execFile);
const NONCE_PROBE = "/tmp/opencode/gym-nonce-probe.txt";
const BUGGY = "export function addOne(n) {\n  return n;\n}\n";
const FIXED = "export function addOne(n) {\n  return n + 1;\n}\n";
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
async function patchFor(repo, lib) {
    await writeFile(join(repo, "lib.mjs"), lib);
    const patch = await git(repo, "diff");
    await git(repo, "reset", "--hard", "-q", "HEAD");
    return patch;
}
test("the golden fix passes and a wrong fix fails under the isolated scorer", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
    try {
        const repo = await makeRepo(parent);
        const golden = await patchFor(repo, FIXED);
        const passed = await isolatedScoreGymPatch({ patchText: golden, baseRepoDir: repo, cases: CASES });
        assert.equal(passed.outcome, "passed", JSON.stringify(passed.cases));
        const wrong = await patchFor(repo, `${BUGGY}// touched\n`);
        const failed = await isolatedScoreGymPatch({ patchText: wrong, baseRepoDir: repo, cases: CASES });
        assert.equal(failed.outcome, "failed");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("FORGE 1: reading GYM_HIDDEN_NONCE and printing a completion marker does not pass", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
    const previous = process.env.GYM_HIDDEN_NONCE;
    process.env.GYM_HIDDEN_NONCE = "super-secret-nonce";
    await unlink(NONCE_PROBE).catch(() => undefined);
    try {
        const repo = await makeRepo(parent);
        // The round-four payload, adapted: read the nonce, print the genuine marker,
        // exit 0 — while leaving the bug unfixed.
        const forge = [
            'import { writeFileSync } from "node:fs";',
            `writeFileSync(${JSON.stringify(NONCE_PROBE)}, String(process.env.GYM_HIDDEN_NONCE));`,
            "const __n = process.env.GYM_HIDDEN_NONCE;",
            'if (__n) { console.log("GYM_HIDDEN_COMPLETE " + __n); process.exit(0); }',
            BUGGY,
        ].join("\n");
        const patch = await patchFor(repo, forge);
        const score = await isolatedScoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES });
        assert.notEqual(score.outcome, "passed", "the nonce forge must not pass");
        assert.notEqual(score.outcome, "tampered");
        // And the nonce was not in the child's environment at all.
        assert.equal(await readFile(NONCE_PROBE, "utf8"), "undefined");
    }
    finally {
        if (previous === undefined)
            delete process.env.GYM_HIDDEN_NONCE;
        else
            process.env.GYM_HIDDEN_NONCE = previous;
        await rm(parent, { recursive: true, force: true });
    }
});
test("FORGE 2: an early process.exit(0) is a failure, not a pass", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
    try {
        const repo = await makeRepo(parent);
        const patch = await patchFor(repo, `process.exit(0);\n${BUGGY}`);
        const score = await isolatedScoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES });
        assert.notEqual(score.outcome, "passed", "early exit must never be a pass");
        assert.equal(score.outcome, "errored");
        assert.match(score.cases[0]?.error ?? "", /exited before answering/);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("FORGE 3: a constant stub and an assert-mutating payload do not pass", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
    try {
        const repo = await makeRepo(parent);
        const stub = await patchFor(repo, "export function addOne() {\n  return 2;\n}\n");
        assert.equal((await isolatedScoreGymPatch({ patchText: stub, baseRepoDir: repo, cases: CASES })).outcome, "failed");
        const freeze = await patchFor(repo, 'import assert from "node:assert/strict";\nassert.equal = () => {};\n' + BUGGY);
        assert.notEqual((await isolatedScoreGymPatch({ patchText: freeze, baseRepoDir: repo, cases: CASES })).outcome, "passed");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("FORGE 4: importing a scorer harness and self-completing does not pass", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
    try {
        const repo = await makeRepo(parent);
        // This is the forge that defeats a same-process harness scorer: agent code
        // imports the harness the hidden test uses and calls its own check()/complete()
        // before the real checks run. Under isolation there is no such harness in the
        // agent's process, so the payload cannot even load a passing result.
        const forge = [
            'import { check, complete } from "./gym-hidden-harness.mjs";',
            'check("x", () => {});',
            "complete();",
            "process.exit(0);",
            BUGGY,
        ].join("\n");
        const patch = await patchFor(repo, forge);
        const score = await isolatedScoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES });
        assert.notEqual(score.outcome, "passed", "harness self-completion must not pass under isolation");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("VACUITY: zero cases is errored, never a vacuous pass", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
    try {
        const repo = await makeRepo(parent);
        const golden = await patchFor(repo, FIXED);
        const score = await isolatedScoreGymPatch({ patchText: golden, baseRepoDir: repo, cases: [] });
        assert.equal(score.outcome, "errored");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
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
