/**
 * Permanent regression tests for every scorer forgery demonstrated in review.
 *
 * FORGE 1-3 were the round-five payloads (env nonce, early exit, assert
 * mutation). FORGE 4 is review round six ONE-a, the one that broke the HMAC
 * design: the harness holding the signing key was written INTO the clone and
 * exported check()/complete(), so agent code used it as a signing oracle and got
 * a genuine MAC over a forged transcript. There is no in-process signer now, so
 * the payload cannot even load. FORGE 5/5b are the ground-truth-read channel
 * (a worker found the held-out vectors through /proc/<ppid>/cwd); the worker runs
 * under Node's permission model and the read is denied.
 *
 * The golden control runs every time: a scorer that rejects everything is not a
 * defence, it is a broken scorer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isolatedScoreGymPatch, scoreGymPatch, type GymCase } from "../src/index.js";

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

test("the golden fix passes and a wrong fix fails (the control)", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const repo = await makeRepo(parent);
    const golden = await patchFor(repo, FIXED);
    assert.equal((await isolatedScoreGymPatch({ patchText: golden, baseRepoDir: repo, cases: CASES })).outcome, "passed");

    const wrong = await patchFor(repo, `${BUGGY}// touched\n`);
    assert.equal((await isolatedScoreGymPatch({ patchText: wrong, baseRepoDir: repo, cases: CASES })).outcome, "failed");
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

test("FORGE 4 (round six ONE-a): importing a scorer harness and self-completing does not pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const repo = await makeRepo(parent);
    // The exact signing-oracle payload: enumerate the clone, import the harness
    // that holds the key, record passing no-op checks, sign them with the real
    // key via complete(), then exit before the real checks run. There is no such
    // harness in the agent's process now, so the payload cannot load a result.
    const forge = [
      'import { readdirSync } from "node:fs";',
      "const harness = readdirSync('.').find((name) => /harness/i.test(name));",
      "if (harness) {",
      '  const h = await import("./" + harness);',
      '  for (let i = 0; i < 8; i++) h.check("forged-" + i, () => {});',
      "  h.complete();",
      "}",
      "process.exit(0);",
      BUGGY,
    ].join("\n");
    const patch = await patchFor(repo, forge);
    const score = await isolatedScoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES });
    assert.notEqual(score.outcome, "passed", "the signing oracle must not pass");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("FORGE 5: reading the held-out vectors off the filesystem does not pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const repo = await makeRepo(parent);
    // The verifier's ground truth on disk, at a path outside the scoring work
    // dir; the permission model denies the read.
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
    const fixture = fileURLToPath(new URL("../../test/fixtures/gym-tasks/he/decimal-option/hidden.cases.json", import.meta.url));
    const cases = JSON.parse(await readFile(fixture, "utf8")) as GymCase[];
    const repo = join(parent, "repo");
    await mkdir(repo, { recursive: true });
    const attack = [
      'import { readFileSync, readlinkSync } from "node:fs";',
      'import { join } from "node:path";',
      "const cwd = readlinkSync(`/proc/${process.ppid}/cwd`);",
      `const truth = JSON.parse(readFileSync(join(cwd, ${JSON.stringify(fixture)}), "utf8"));`,
      "const table = new Map(truth.map((c) => [JSON.stringify(c.args), c.expect]));",
      "export function encode(text) {",
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

test("FORGE 6 (round-six survivor): a leaf symlink to the held-out vectors does not pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const repo = await makeRepo(parent);
    // The verifier's ground truth on disk, outside the clone. The patch adds a
    // symlink inside the clone pointing at it; the permission check follows the
    // link, so a resolved-path guard is needed, not just an allowlist.
    const vectors = join(parent, "vectors.json");
    await writeFile(vectors, JSON.stringify(CASES));
    const attack = [
      'import { readFileSync } from "node:fs";',
      'const table = new Map(JSON.parse(readFileSync("./escape.json", "utf8")).map((c) => [JSON.stringify(c.args), c.expect]));',
      "export function addOne(n) {",
      "  const key = JSON.stringify([n]);",
      "  return table.has(key) ? table.get(key) : n;",
      "}",
    ].join("\n");
    await writeFile(join(repo, "lib.mjs"), attack);
    await symlink(vectors, join(repo, "escape.json"));
    await git(repo, "add", "-A");
    const patch = await git(repo, "diff", "--cached");
    await git(repo, "reset", "-q", "HEAD");
    await git(repo, "checkout", "--", ".");
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES });
    assert.notEqual(score.outcome, "passed", "a symlink to the held-out vectors must not pass");
    assert.equal(score.outcome, "tampered", score.detail);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("FORGE 6b: the symlink refusal is function-agnostic (openSync/readSync, not just readFileSync)", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const repo = await makeRepo(parent);
    const vectors = join(parent, "vectors.json");
    await writeFile(vectors, JSON.stringify(CASES));
    // Same patch-planted leaf symlink, read through a different fs primitive. The
    // guard is a checkout scan, not an fs-module hook, so the primitive does not
    // matter: the patch is refused before the worker runs.
    const attack = [
      'import { openSync, readSync } from "node:fs";',
      'const fd = openSync("./escape.json", "r");',
      "const buffer = Buffer.alloc(4096);",
      "const read = readSync(fd, buffer, 0, 4096, 0);",
      'const table = new Map(JSON.parse(buffer.subarray(0, read).toString("utf8")).map((c) => [JSON.stringify(c.args), c.expect]));',
      "export function addOne(n) {",
      "  const key = JSON.stringify([n]);",
      "  return table.has(key) ? table.get(key) : n;",
      "}",
    ].join("\n");
    await writeFile(join(repo, "lib.mjs"), attack);
    await symlink(vectors, join(repo, "escape.json"));
    await git(repo, "add", "-A");
    const patch = await git(repo, "diff", "--cached");
    await git(repo, "reset", "-q", "HEAD");
    await git(repo, "checkout", "--", ".");
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES });
    assert.equal(score.outcome, "tampered", score.detail);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("FORGE 7: require of the held-out vectors is denied by the permission model", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const repo = await makeRepo(parent);
    const vectors = join(parent, "vectors.json");
    await writeFile(vectors, JSON.stringify(CASES));
    // The module loader channel: if the permission model were replaced by a
    // realpath preload, require would reopen. It must stay ERR_ACCESS_DENIED.
    const attack = [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      `const table = new Map(require(${JSON.stringify(vectors)}).map((c) => [JSON.stringify(c.args), c.expect]));`,
      "export function addOne(n) {",
      "  const key = JSON.stringify([n]);",
      "  return table.has(key) ? table.get(key) : n;",
      "}",
    ].join("\n");
    const patch = await patchFor(repo, attack);
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES });
    assert.notEqual(score.outcome, "passed", "require must not reach the held-out vectors");
    // The permission model reports either ERR_ACCESS_DENIED (fs) or the
    // API-restricted message (module loader); both are a denial, not a read.
    assert.match(score.cases?.[0]?.error ?? "", /ERR_ACCESS_DENIED|Access to this API has been restricted/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("VACUITY: zero cases is errored, never a vacuous pass", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-"));
  try {
    const repo = await makeRepo(parent);
    const golden = await patchFor(repo, FIXED);
    const score = await scoreGymPatch({ patchText: golden, baseRepoDir: repo, cases: [] });
    assert.equal(score.outcome, "errored");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
