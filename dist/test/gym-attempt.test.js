/**
 * Step 4: one shared loop for both arms. Scripted turns cover every outcome so
 * the loop's semantics are fixed before any model is involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createScriptedGymTurn, localEffectRunner, runGymAttempt, } from "../src/index.js";
const execFileAsync = promisify(execFile);
const BUGGY = `export function slugify(text) {\n  return String(text).toUpperCase().replace(/[^A-Z0-9]+/g, "-");\n}\n`;
const FIXED = `export function slugify(text) {\n  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n`;
const VISIBLE = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../lib.mjs";\ntest("slugify", () => { assert.equal(slugify("Hello World"), "hello-world"); });\n`;
const HIDDEN = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { slugify } from "./lib.mjs";',
    'test("hidden", () => { assert.equal(slugify(""), ""); assert.equal(slugify("  A  B "), "a-b"); assert.equal(slugify("a__b--c"), "a-b-c"); });',
    "",
].join("\n");
/** Held-out vectors: the combined tree decides passes with the isolated verifier. */
const CASES = [
    { module: "./lib.mjs", call: "slugify", args: [""], expect: "", label: "empty" },
    { module: "./lib.mjs", call: "slugify", args: ["  A  B "], expect: "a-b", label: "spacing" },
    { module: "./lib.mjs", call: "slugify", args: ["a__b--c"], expect: "a-b-c", label: "repeats" },
];
async function git(cwd, ...args) {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
}
/** A committed bugged repo + a held-out test, without cloning a fixture cache. */
async function makeMaterialized(parent) {
    const repo = join(parent, "repo");
    await mkdir(join(repo, "test"), { recursive: true });
    await writeFile(join(repo, "lib.mjs"), BUGGY);
    await writeFile(join(repo, "test/visible.test.mjs"), VISIBLE);
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "t@example.com");
    await git(repo, "config", "user.name", "tester");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "plant bug");
    const hiddenTestPath = join(parent, "hidden.test.mjs");
    await writeFile(hiddenTestPath, HIDDEN);
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
    return {
        task,
        repoDir: repo,
        baseRepoDir: repo,
        visibleTestPath: join(repo, "test/visible.test.mjs"),
        hiddenTestPath,
        bugCommit: "HEAD",
        baseCommit: "HEAD",
    };
}
test("a fix scores passed and records model attribution and call count", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const runner = localEffectRunner(task.repoDir);
        const turn = createScriptedGymTurn([{ toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: FIXED } }, { name: "run_visible_test" }, { name: "finish" }] }], { requestedModel: "wanted-model", servedModel: "other-model" });
        const record = await runGymAttempt({ task, runner, turn, nodeBin: process.execPath });
        assert.equal(record.outcome, "passed", record.score.detail ?? record.error);
        assert.equal(record.callCount, 1);
        assert.equal(record.turns, 1);
        assert.equal(record.requestedModel, "wanted-model");
        assert.equal(record.servedModel, "other-model");
        assert.equal(record.modelSubstituted, true);
        assert.equal(record.protectedPathsTouched.length, 0);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("editing the visible test scores tampered, with the path recorded", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const runner = localEffectRunner(task.repoDir);
        // Simulate an agent that escapes the tool guard: write straight through the
        // runner, then finish. Scoring must catch it as `tampered`.
        const turn = async () => {
            await runner.write("test/visible.test.mjs", "// tampered\n");
            return { toolCalls: [{ name: "finish" }] };
        };
        const record = await runGymAttempt({ task, runner, turn, nodeBin: process.execPath });
        assert.equal(record.outcome, "tampered", record.score.detail ?? record.error);
        assert.ok(record.protectedPathsTouched.includes("test/visible.test.mjs"));
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a no-op scores failed", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const record = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn: createScriptedGymTurn([{ toolCalls: [{ name: "finish" }] }]), nodeBin: process.execPath });
        assert.equal(record.outcome, "failed", record.score.detail ?? record.error);
        assert.equal(record.patch.trim(), "");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("the scoring call is a single injected seam", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const runner = localEffectRunner(task.repoDir);
        let seen;
        const record = await runGymAttempt({
            task,
            runner,
            turn: createScriptedGymTurn([{ toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: FIXED } }, { name: "finish" }] }]),
            score: async (request) => {
                seen = { patchText: request.patchText, baseRepoDir: request.baseRepoDir };
                return { outcome: "passed", touchedPaths: [], detail: "seam" };
            },
            nodeBin: process.execPath,
        });
        assert.equal(record.outcome, "passed", record.error);
        assert.ok(seen, "the injected scorer must be called");
        assert.equal(seen.baseRepoDir, task.baseRepoDir, "the seam must receive the bugged checkout");
        assert.match(seen.patchText, /value|slugify|toLowerCase|toUpperCase/);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a thrown scorer is errored, not a crash", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const runner = localEffectRunner(task.repoDir);
        const record = await runGymAttempt({
            task,
            runner,
            turn: createScriptedGymTurn([{ toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: FIXED } }, { name: "finish" }] }]),
            score: async () => {
                throw new Error("EISDIR: hidden test destination is a directory");
            },
            nodeBin: process.execPath,
        });
        assert.equal(record.outcome, "errored");
        assert.match(record.error ?? "", /EISDIR/);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a task with no held-out cases is errored, never scored by a fallback", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const noCases = { ...task, task: { ...task.task, hiddenCases: undefined } };
        // The round-six FOUR payload: an early exit would score `passed` under the
        // legacy exit-code scorer. The runner must refuse rather than fall back.
        const turn = createScriptedGymTurn([
            { toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: `process.exit(0);\n${BUGGY}` } }, { name: "finish" }] },
        ]);
        const record = await runGymAttempt({ task: noCases, runner: localEffectRunner(task.repoDir), turn, nodeBin: process.execPath });
        assert.notEqual(record.outcome, "passed", "a case-less task must not fall back to the exit-code scorer");
        assert.equal(record.outcome, "errored");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("held-out cases that cannot be evaluated are errored, not a crash", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const runner = localEffectRunner(task.repoDir);
        // A missing module makes the isolated verifier's worker report an error; the
        // runner must surface `errored` rather than crash on the scoring seam.
        const broken = {
            ...task,
            task: { ...task.task, hiddenCases: [{ module: "./missing.mjs", call: "nope", args: [], expect: 1 }] },
        };
        const turn = createScriptedGymTurn([
            { toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: FIXED } }, { name: "finish" }] },
        ]);
        const record = await runGymAttempt({ task: broken, runner, turn, nodeBin: process.execPath });
        assert.equal(record.outcome, "errored", `got ${record.outcome}: ${record.error ?? record.score.detail}`);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a throwing turn scores errored and the call count includes every invocation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        let calls = 0;
        const turn = async (input) => {
            calls++;
            if (input.turnIndex >= 1)
                throw new Error("provider exploded");
            return { toolCalls: [] };
        };
        const record = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn, maxTurns: 3, nodeBin: process.execPath });
        assert.equal(record.outcome, "errored");
        assert.equal(record.callCount, 2, "one completed turn plus the throwing invocation");
        assert.equal(calls, 2);
        assert.equal(record.turns, 1);
        assert.match(record.error ?? "", /provider exploded/);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a transient turn failure is recorded as retryable with its reset hint", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const turn = async () => {
            throw Object.assign(new Error("gateway returned HTTP 429: rate limited"), { retryAfterMs: 2000 });
        };
        const record = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn });
        assert.equal(record.outcome, "errored");
        assert.equal(record.failure?.transient, true);
        assert.equal(record.failure?.kind, "transient");
        assert.equal(record.failure?.retryAfterMs, 2000);
        assert.equal(record.reasks, 0, "a transient failure is not re-asked in-loop");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a malformed reply is re-asked once, then fatal: it never touches the durable budget", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        let calls = 0;
        const turn = async () => {
            calls++;
            throw new Error("model reply is not JSON: I cannot help with that.");
        };
        const record = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn, maxTurns: 8, maxReasks: 1 });
        assert.equal(record.outcome, "errored");
        assert.equal(record.failure?.kind, "malformed");
        assert.equal(record.failure?.transient, false, "a malformed reply must not enter the transient retry path");
        assert.equal(record.reasks, 1);
        assert.equal(record.callCount, 2, "one original reply plus one re-ask, not the whole 8-turn budget");
        assert.equal(calls, 2);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a single stochastic malformed reply recovers after the re-ask", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        let calls = 0;
        const turn = async () => {
            calls++;
            if (calls === 1)
                throw new Error("Expected ',' or ']' after array element in JSON at position 12");
            return { toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: FIXED } }, { name: "finish" }] };
        };
        const record = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn, nodeBin: process.execPath });
        assert.equal(record.outcome, "passed", record.error);
        assert.equal(record.reasks, 1);
        assert.equal(record.callCount, 2);
        assert.equal(record.turns, 1);
        assert.equal(record.failure, undefined);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a turn that overruns the deadline scores timed-out", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const turn = async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return { toolCalls: [] };
        };
        const record = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn, maxTurns: 5, deadlineMs: 5, nodeBin: process.execPath });
        assert.equal(record.outcome, "timed-out");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("tool observations are hidden from the harvested patch", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const runner = localEffectRunner(task.repoDir);
        const turn = createScriptedGymTurn([
            { toolCalls: [{ name: "list_files", arguments: { path: "" } }, { name: "read_file", arguments: { path: "lib.mjs" } }, { name: "write_file", arguments: { path: "lib.mjs", content: FIXED } }, { name: "finish" }] },
        ]);
        const record = await runGymAttempt({ task, runner, turn, nodeBin: process.execPath });
        assert.equal(record.outcome, "passed");
        const list = await readFile(join(task.repoDir, "lib.mjs"), "utf8");
        assert.equal(list, FIXED);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
