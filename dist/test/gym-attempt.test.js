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
        assert.equal(record.outcome, "passed", record.score.hiddenOutput ?? record.error);
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
        assert.equal(record.outcome, "tampered", record.score.detail ?? record.score.hiddenOutput);
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
        assert.equal(record.outcome, "failed", record.score.hiddenOutput ?? record.error);
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
test("a patch that turns the hidden-test destination into a directory is errored, not a crash", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const runner = localEffectRunner(task.repoDir);
        // `hidden.test.mjs` is the scorer's copy destination. A directory there makes
        // `copyFile` throw inside scoreGymPatch; the runner must surface `errored`.
        const turn = createScriptedGymTurn([
            { toolCalls: [{ name: "write_file", arguments: { path: "hidden.test.mjs/placeholder", content: "not a test\n" } }, { name: "finish" }] },
        ]);
        const record = await runGymAttempt({ task, runner, turn, nodeBin: process.execPath });
        assert.equal(record.outcome, "errored", `got ${record.outcome}: ${record.error ?? record.score.detail}`);
        assert.match(record.error ?? "", /EISDIR|directory/);
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
        assert.equal(record.failure?.retryAfterMs, 2000);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("a malformed model reply is not classified as retryable", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-attempt-"));
    try {
        const task = await makeMaterialized(parent);
        const turn = async () => {
            throw new Error("model reply is not JSON: I cannot help with that.");
        };
        const record = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn });
        assert.equal(record.outcome, "errored");
        assert.equal(record.failure?.transient, false);
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
