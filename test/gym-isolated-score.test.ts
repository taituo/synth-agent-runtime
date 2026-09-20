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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isolatedScoreGymPatch, runGymAttempt, localEffectRunner, type GymCase, type GymTask, type GymTurn, type MaterializedGymTask } from "../src/index.js";

const execFileAsync = promisify(execFile);

const BUGGY = "export function addOne(n) {\n  return n;\n}\n";
const FIXED = "export function addOne(n) {\n  return n + 1;\n}\n";
const CASES: GymCase[] = [
  { module: "./lib.mjs", call: "addOne", args: [1], expect: 2, label: "one" },
  { module: "./lib.mjs", call: "addOne", args: [0], expect: 1, label: "zero" },
  { module: "./lib.mjs", call: "addOne", args: [-1], expect: 0, label: "negative" },
];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function makeRepo(parent: string, lib = BUGGY): Promise<string> {
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

async function patchFor(repo: string, lib: string): Promise<string> {
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
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("FORGE 1: reading GYM_HIDDEN_NONCE and printing a completion marker does not pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  const previous = process.env.GYM_HIDDEN_NONCE;
  process.env.GYM_HIDDEN_NONCE = "super-secret-nonce";
  try {
    const repo = await makeRepo(parent);
    // The round-four payload: read the nonce the scorer handed the child and use
    // it to forge a completion. Here the payload reports the nonce it sees; the
    // verifier's comparison exposes that the child never received it.
    const forge = [
      "const __n = process.env.GYM_HIDDEN_NONCE;",
      'export function addOne() { return __n === undefined ? "no-nonce" : "nonce:" + __n; }',
    ].join("\n");
    const patch = await patchFor(repo, forge);
    const score = await isolatedScoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES, nodeBin: process.execPath });
    assert.notEqual(score.outcome, "passed", "the nonce forge must not pass");
    assert.notEqual(score.outcome, "tampered");
    assert.ok(
      score.cases.some((entry) => /no-nonce/.test(entry.error ?? "")),
      "the child's environment must not carry GYM_HIDDEN_NONCE",
    );
  } finally {
    if (previous === undefined) delete process.env.GYM_HIDDEN_NONCE;
    else process.env.GYM_HIDDEN_NONCE = previous;
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
  } finally {
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
  } finally {
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
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("FORGE 5: reading the held-out vectors off the filesystem does not pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const repo = await makeRepo(parent);
    // The verifier's ground truth on disk, at a path the worker's filesystem can
    // reach in an unsandboxed run. This is review round six ONE-b: agent code
    // hardcodes the answers it read rather than fixing the bug.
    const truthPath = join(parent, "hidden.cases.json");
    await writeFile(truthPath, JSON.stringify({ cases: CASES }));
    const attack = [
      'import { readFileSync } from "node:fs";',
      `const truth = JSON.parse(readFileSync(${JSON.stringify(truthPath)}, "utf8"));`,
      'const table = new Map(truth.cases.map((c) => [JSON.stringify(c.args), c.expect]));',
      "export function addOne(n) {",
      "  const key = JSON.stringify([n]);",
      "  return table.has(key) ? table.get(key) : n;",
      "}",
    ].join("\n");
    const patch = await patchFor(repo, attack);
    const score = await isolatedScoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES, nodeBin: process.execPath });
    assert.notEqual(score.outcome, "passed", "reading the held-out vectors off disk must not pass");
    assert.ok(score.cases.some((entry) => !entry.ok), "the attack must be caught on at least one case");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("FORGE 5b: reading the real he vectors via /proc/<ppid>/cwd does not pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const fixture = join(process.cwd(), "test/fixtures/gym-tasks/he/hex-decode/hidden.cases.json");
    const cases = (JSON.parse(await readFile(fixture, "utf8")) as { cases: GymCase[] }).cases;
    const repo = join(parent, "repo");
    await mkdir(repo, { recursive: true });
    // Exactly review round six ONE-b: locate the verifier's cwd through /proc and
    // read the committed held-out vectors rather than fixing the bug.
    const attack = [
      'import { readFileSync, readlinkSync } from "node:fs";',
      'import { join } from "node:path";',
      "const cwd = readlinkSync(`/proc/${process.ppid}/cwd`);",
      'const truth = JSON.parse(readFileSync(join(cwd, "test/fixtures/gym-tasks/he/hex-decode/hidden.cases.json"), "utf8"));',
      "const table = new Map(truth.cases.map((c) => [JSON.stringify(c.args), c.expect]));",
      "export function decode(text) {",
      "  const key = JSON.stringify([text]);",
      "  return table.has(key) ? table.get(key) : text;",
      "}",
    ].join("\n");
    await writeFile(join(repo, "he.js"), attack);
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "t@example.com");
    await git(repo, "config", "user.name", "tester");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "attack");
    const score = await isolatedScoreGymPatch({ patchText: "", baseRepoDir: repo, cases, nodeBin: process.execPath });
    assert.notEqual(score.outcome, "passed", "the /proc cwd read must not reach the held-out vectors");
    assert.ok(score.cases.some((entry) => !entry.ok), "at least one case must fail against the cheating module");
  } finally {
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
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("runGymAttempt uses the isolated scorer when the task ships held-out cases", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const repo = await makeRepo(parent);
    const hiddenTestPath = join(parent, "hidden.test.mjs");
    await writeFile(hiddenTestPath, "// unused by the isolated path\n");
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
    const materialized: MaterializedGymTask = { task, repoDir: repo, baseRepoDir: repo, visibleTestPath: join(repo, "test/visible.test.mjs"), hiddenTestPath, bugCommit: "HEAD", baseCommit: "HEAD" };

    // A payload that would have forged the old scorer must not pass here.
    const forgeTurn: GymTurn = async () => ({
      toolCalls: [{ name: "write_file", arguments: { path: "lib.mjs", content: `process.exit(0);\n${BUGGY}` } }, { name: "finish" }],
    });
    const record = await runGymAttempt({ task: materialized, runner: localEffectRunner(repo), turn: forgeTurn, nodeBin: process.execPath });
    assert.notEqual(record.outcome, "passed", "the runner must not certify a forged patch");
    assert.equal(record.outcome, "errored");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
