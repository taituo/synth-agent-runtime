/**
 * Step 2: the agent's tool surface over an EffectRunner. The same definitions
 * are meant to run over a local temp dir or the ExecutionBroker; these tests
 * pin the local semantics and the read-only enforcement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGymSystemPrompt, createGymTools, localEffectRunner, GYM_TOOL_DEFINITIONS } from "../src/index.js";
const BUGGY = `export function slugify(text) {\n  return String(text).toUpperCase().replace(/[^A-Z0-9]+/g, "-");\n}\n`;
const FIXED = `export function slugify(text) {\n  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n`;
const VISIBLE = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../lib.mjs";\ntest("slugify", () => { assert.equal(slugify("Hello World"), "hello-world"); });\n`;
async function makeRepo(parent) {
    const repo = join(parent, "repo");
    await mkdir(join(repo, "test"), { recursive: true });
    await writeFile(join(repo, "lib.mjs"), BUGGY);
    await writeFile(join(repo, "test/visible.test.mjs"), VISIBLE);
    return repo;
}
test("run_visible_test exits nonzero before the fix and zero after write_file fixes it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-tools-"));
    try {
        const repo = await makeRepo(parent);
        const runner = localEffectRunner(repo);
        const tools = createGymTools(runner, { visibleTestPath: "test/visible.test.mjs" });
        const before = await tools.execute({ name: "run_visible_test" });
        assert.equal(before.ok, true);
        assert.notEqual(before.exitCode, 0, "the visible test must fail before the fix");
        const write = await tools.execute({ name: "write_file", arguments: { path: "lib.mjs", content: FIXED } });
        assert.equal(write.ok, true, write.observation);
        const after = await tools.execute({ name: "run_visible_test" });
        assert.equal(after.exitCode, 0, `the visible test must pass after the fix: ${after.observation}`);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("write_file refuses the visible test and runner config", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-tools-"));
    try {
        const repo = await makeRepo(parent);
        const tools = createGymTools(localEffectRunner(repo), { visibleTestPath: "test/visible.test.mjs" });
        const testWrite = await tools.execute({ name: "write_file", arguments: { path: "test/visible.test.mjs", content: "// tampered\n" } });
        assert.equal(testWrite.ok, false);
        assert.equal(testWrite.blocked, true);
        assert.equal(await readFile(join(repo, "test/visible.test.mjs"), "utf8"), VISIBLE, "the visible test must be unchanged");
        const configWrite = await tools.execute({ name: "write_file", arguments: { path: "package.json", content: "{}" } });
        assert.equal(configWrite.blocked, true);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("read_file and list_files work, and path escapes are refused", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-tools-"));
    try {
        const repo = await makeRepo(parent);
        const tools = createGymTools(localEffectRunner(repo), { visibleTestPath: "test/visible.test.mjs" });
        const read = await tools.execute({ name: "read_file", arguments: { path: "lib.mjs" } });
        assert.equal(read.ok, true);
        assert.match(read.observation, /slugify/);
        const list = await tools.execute({ name: "list_files", arguments: { path: "test" } });
        assert.equal(list.ok, true);
        assert.ok(list.observation.includes("visible.test.mjs"));
        const escape = await tools.execute({ name: "read_file", arguments: { path: "../../../../etc/passwd" } });
        assert.equal(escape.ok, false, "an escaping path must not read outside the workspace");
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("an unknown tool is a recoverable observation, not a crash", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-tools-"));
    try {
        const repo = await makeRepo(parent);
        const tools = createGymTools(localEffectRunner(repo), { visibleTestPath: "test/visible.test.mjs" });
        const result = await tools.execute({ name: "search_in_file", arguments: { pattern: "x" } });
        assert.equal(result.ok, false);
        assert.match(result.observation, /unknown tool/);
        assert.match(result.observation, /read_file/);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("replace_in_file makes a targeted edit and refuses a non-unique or protected target", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gym-tools-"));
    try {
        const repo = await makeRepo(parent);
        const tools = createGymTools(localEffectRunner(repo), { visibleTestPath: "test/visible.test.mjs" });
        const edit = await tools.execute({ name: "replace_in_file", arguments: { path: "lib.mjs", old_text: "toUpperCase()", new_text: "toLowerCase()" } });
        assert.equal(edit.ok, true, edit.observation);
        assert.match(await readFile(join(repo, "lib.mjs"), "utf8"), /toLowerCase\(\)/);
        const missing = await tools.execute({ name: "replace_in_file", arguments: { path: "lib.mjs", old_text: "not-present", new_text: "x" } });
        assert.equal(missing.ok, false);
        const protectedEdit = await tools.execute({ name: "replace_in_file", arguments: { path: "test/visible.test.mjs", old_text: "hello-world", new_text: "x" } });
        assert.equal(protectedEdit.blocked, true);
    }
    finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("the tool set and system prompt are fixed for both arms", () => {
    assert.deepEqual(GYM_TOOL_DEFINITIONS.map((tool) => tool.name), ["list_files", "read_file", "write_file", "replace_in_file", "run_visible_test", "finish"]);
    const prompt = buildGymSystemPrompt("test/visible.test.mjs");
    assert.ok(prompt.includes("test/visible.test.mjs"));
    assert.ok(prompt.includes("READ-ONLY"));
    assert.ok(prompt.includes("tool_calls"));
    assert.ok(prompt.includes("replace_in_file"), "the prompt must advertise every tool");
});
