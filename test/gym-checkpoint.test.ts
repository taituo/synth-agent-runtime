/**
 * Work-product checkpoints: the fix for "control-plane durability is not
 * work-product durability". A resumed attempt must continue from the agent's
 * edits, not re-materialize the bugged checkout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BlobGymCheckpointStore,
  FileSystemBlobStore,
  localEffectRunner,
  runGymAttempt,
  type GymCase,
  type GymTask,
  type GymTurn,
  type MaterializedGymTask,
} from "../src/index.js";

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
const CASES: GymCase[] = [
  { module: "./lib.mjs", call: "slugify", args: [""], expect: "", label: "empty" },
  { module: "./lib.mjs", call: "slugify", args: ["  A  B "], expect: "a-b", label: "spacing" },
  { module: "./lib.mjs", call: "slugify", args: ["a__b--c"], expect: "a-b-c", label: "repeats" },
];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function makeMaterialized(parent: string): Promise<MaterializedGymTask> {
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
  const task: GymTask = {
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
  return { task, repoDir: repo, baseRepoDir: repo, visibleTestPath: join(repo, "test/visible.test.mjs"), hiddenTestPath, bugCommit: "HEAD", baseCommit: "HEAD" };
}

function makeStore(parent: string): BlobGymCheckpointStore {
  return new BlobGymCheckpointStore(new FileSystemBlobStore(join(parent, "blobs")), join(parent, "pointers"));
}

test("checkpoints round-trip through the blob store with a provenance chain", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-cp-"));
  try {
    const blobs = new FileSystemBlobStore(join(parent, "blobs"));
    const store = new BlobGymCheckpointStore(blobs, join(parent, "pointers"));
    const first = await store.save("k", { turnIndex: 1, patchText: "p1", transcript: [{ role: "assistant", content: "a" }] });
    const second = await store.save("k", { turnIndex: 2, patchText: "p2", transcript: [], parentDigest: first });

    const loaded = await store.load("k");
    assert.equal(loaded?.turnIndex, 2);
    assert.equal(loaded?.patchText, "p2");
    assert.equal(loaded?.digest, second);
    assert.deepEqual((await blobs.stat(second))?.producedFrom, [first], "the chain points at the previous checkpoint");
    assert.equal(await store.load("missing"), undefined);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("replay case: a resumed attempt re-applies a checkpoint that already holds the fix", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-cp-"));
  try {
    const task = await makeMaterialized(parent);
    const store = makeStore(parent);
    const key = "resume";
    const lib = join(task.repoDir, "lib.mjs");

    // First attempt: edit on turn 0, then die on a transient error on turn 1.
    const dyingTurn: GymTurn = async (input) => {
      if (input.turnIndex === 0) return { toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: FIXED } }] };
      throw Object.assign(new Error("gateway returned HTTP 502: killed"), { retryAfterMs: 10 });
    };
    const first = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn: dyingTurn, maxTurns: 8, checkpoint: store, checkpointKey: key, nodeBin: process.execPath });
    assert.equal(first.outcome, "errored");

    // Simulate the activity retry re-materializing the pinned bugged checkout.
    await git(task.repoDir, "reset", "--hard", "-q", "HEAD");
    assert.match(await readFile(lib, "utf8"), /toUpperCase/, "the workspace is back to the bugged base");

    // Resumed attempt: the workspace must already hold the edit, and the loop
    // must continue at turn 1 rather than re-running from zero.
    let seenTurnIndex = -1;
    const finishTurn: GymTurn = async (input) => {
      seenTurnIndex = input.turnIndex;
      assert.match(await readFile(lib, "utf8"), /toLowerCase/, "checkpointed edit must be restored before the resumed turn");
      return { toolCalls: [{ name: "finish" }] };
    };
    const second = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn: finishTurn, maxTurns: 8, checkpoint: store, checkpointKey: key, nodeBin: process.execPath });
    assert.equal(seenTurnIndex, 1, "the resumed loop starts after the completed turn");
    assert.equal(second.resumedFromTurn, 1);
    assert.equal(second.outcome, "passed", second.error);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("stronger claim: with a non-fixing checkpoint the resumed attempt must make the edit", async () => {
  // The SIGKILL 4/4 result only shows pre-kill work is re-applied: a checkpoint
  // can already contain the finished fix, so a resumed attempt that only calls
  // finish scores passed. This variant removes that ambiguity: the checkpoint
  // holds a PARTIAL, non-fixing edit, so a pass requires the resumed attempt to
  // produce the fix itself, after resume.
  const parent = await mkdtemp(join(tmpdir(), "gym-cp-"));
  try {
    const task = await makeMaterialized(parent);
    const store = makeStore(parent);
    const key = "resume-new-edit";
    const lib = join(task.repoDir, "lib.mjs");
    const PARTIAL = `${BUGGY}// partial progress, still buggy\n`;

    const dyingTurn: GymTurn = async (input) => {
      if (input.turnIndex === 0) return { toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: PARTIAL } }] };
      throw Object.assign(new Error("gateway returned HTTP 502: killed"), { retryAfterMs: 10 });
    };
    const first = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn: dyingTurn, maxTurns: 8, checkpoint: store, checkpointKey: key, nodeBin: process.execPath });
    assert.equal(first.outcome, "errored");

    const saved = await store.load(key);
    assert.ok(saved, "a checkpoint must exist");
    assert.ok(saved.patchText.includes("partial progress"), "the checkpoint holds the partial edit");
    assert.ok(!saved.patchText.includes("toLowerCase"), "the checkpoint must NOT already contain the fix");

    // Simulate the retried activity re-materializing the pinned bugged checkout.
    await git(task.repoDir, "reset", "--hard", "-q", "HEAD");

    let ranAt = -1;
    let sawFixBeforeEdit = true;
    const fixTurn: GymTurn = async (input) => {
      ranAt = input.turnIndex;
      const current = await readFile(lib, "utf8");
      assert.match(current, /partial progress/, "resume must restore the pre-kill partial work");
      sawFixBeforeEdit = current.includes("toLowerCase");
      return { toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: FIXED } }, { name: "finish" }] };
    };
    const second = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn: fixTurn, maxTurns: 8, checkpoint: store, checkpointKey: key, nodeBin: process.execPath });
    assert.equal(ranAt, 1, "the resumed loop continues after the checkpointed turn");
    assert.equal(sawFixBeforeEdit, false, "the fix was absent before the resumed edit");
    assert.equal(second.resumedFromTurn, 1);
    assert.equal(second.outcome, "passed", second.error);
    assert.ok(second.patch.includes("toLowerCase"), "the final patch was produced by the resumed attempt");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("control: without a checkpoint the second attempt restarts from the bugged base", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-cp-"));
  try {
    const task = await makeMaterialized(parent);
    const store = makeStore(parent);
    const lib = join(task.repoDir, "lib.mjs");
    const dyingTurn: GymTurn = async (input) => {
      if (input.turnIndex === 0) return { toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: FIXED } }] };
      throw new Error("gateway returned HTTP 502: killed");
    };
    // Write a checkpoint under a DIFFERENT key, then resume under a fresh one.
    await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn: dyingTurn, maxTurns: 8, checkpoint: store, checkpointKey: "other", nodeBin: process.execPath });
    await git(task.repoDir, "reset", "--hard", "-q", "HEAD");

    let seenTurnIndex = -1;
    const finishTurn: GymTurn = async (input) => {
      seenTurnIndex = input.turnIndex;
      assert.match(await readFile(lib, "utf8"), /toUpperCase/, "no checkpoint means the bugged base");
      return { toolCalls: [{ name: "finish" }] };
    };
    const second = await runGymAttempt({ task, runner: localEffectRunner(task.repoDir), turn: finishTurn, maxTurns: 8, checkpoint: store, checkpointKey: "fresh", nodeBin: process.execPath });
    assert.equal(seenTurnIndex, 0);
    assert.equal(second.resumedFromTurn, undefined);
    assert.equal(second.outcome, "failed");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
