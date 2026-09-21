/**
 * Regression tests for the scorer hardening ported from `main`:
 *
 *   - `node:sqlite` is NOT gated by Node's permission model. An allowlisted work
 *     dir still let a worker open and mutate SQLite databases outside it (review
 *     round six). The worker is now spawned with `--no-experimental-sqlite`, so
 *     `require("node:sqlite")` fails inside the worker.
 *   - `SYNTH_REQUIRE_ISOLATION=1` is a refusal, not a fail-open: a deployment
 *     that needs an OS boundary gets `errored` instead of agent code on the host.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isolatedScoreGymPatch, sandboxScorerConfig, type GymCase } from "../src/index.js";

const execFileAsync = promisify(execFile);
const require_ = createRequire(import.meta.url);

const BUGGY = "export function addOne(n) {\n  return n;\n}\n";
const FIXED = "export function addOne(n) {\n  return n + 1;\n}\n";
const CASES: GymCase[] = [
  { module: "./lib.mjs", call: "addOne", args: [1], expect: 2, label: "one" },
  { module: "./lib.mjs", call: "addOne", args: [0], expect: 1, label: "zero" },
];

/** The probe returns "sqlite:yes" if the worker can load node:sqlite. */
const SQLITE_PROBE = [
  'import { createRequire } from "node:module";',
  "const require = createRequire(import.meta.url);",
  "let available = false;",
  'try { require("node:sqlite"); available = true; } catch {}',
  'export function probe() { return "sqlite:" + (available ? "yes" : "no"); }',
  "export function addOne(n) { return n + 1; }",
].join("\n");

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

test("SYNTH_REQUIRE_ISOLATION=1 refuses the host worker instead of running agent code", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-hard-"));
  const previous = process.env.SYNTH_REQUIRE_ISOLATION;
  process.env.SYNTH_REQUIRE_ISOLATION = "1";
  try {
    const repo = await makeRepo(parent);
    const score = await isolatedScoreGymPatch({ patchText: "", baseRepoDir: repo, cases: CASES });
    assert.equal(score.outcome, "errored");
    assert.match(score.detail ?? "", /SYNTH_REQUIRE_ISOLATION=1/);
    assert.equal(score.cases.length, 0);
  } finally {
    if (previous === undefined) delete process.env.SYNTH_REQUIRE_ISOLATION;
    else process.env.SYNTH_REQUIRE_ISOLATION = previous;
    await rm(parent, { recursive: true, force: true });
  }
});

test("the pod boundary is selected by configuration; sandbox:false forces the host path", async () => {
  const saved = {
    image: process.env.SYNTH_EXECUTOR_IMAGE,
    gate: process.env.SYNTH_SCORER_SANDBOX,
    require: process.env.SYNTH_REQUIRE_ISOLATION,
  };
  const parent = await mkdtemp(join(tmpdir(), "gym-iso-config-"));
  try {
    delete process.env.SYNTH_EXECUTOR_IMAGE;
    delete process.env.SYNTH_SCORER_SANDBOX;
    assert.equal(sandboxScorerConfig(), undefined, "no cluster image means no OS boundary is configured");

    process.env.SYNTH_EXECUTOR_IMAGE = `registry.example/synth-executor@sha256:${"a".repeat(64)}`;
    assert.equal(sandboxScorerConfig()?.image, process.env.SYNTH_EXECUTOR_IMAGE, "an image selects the pod boundary");
    process.env.SYNTH_SCORER_SANDBOX = "0";
    assert.equal(sandboxScorerConfig(), undefined, "SYNTH_SCORER_SANDBOX=0 forces the host path");

    // An image is configured, but this caller explicitly forces the host, so a
    // required-isolation run must still refuse rather than run agent code there.
    delete process.env.SYNTH_SCORER_SANDBOX;
    process.env.SYNTH_REQUIRE_ISOLATION = "1";
    const repo = await makeRepo(parent);
    const score = await isolatedScoreGymPatch({ patchText: "", baseRepoDir: repo, cases: CASES, sandbox: false });
    assert.equal(score.outcome, "errored");
    assert.match(score.detail ?? "", /SYNTH_REQUIRE_ISOLATION=1/);
  } finally {
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("SYNTH_EXECUTOR_IMAGE", saved.image);
    restore("SYNTH_SCORER_SANDBOX", saved.gate);
    restore("SYNTH_REQUIRE_ISOLATION", saved.require);
    await rm(parent, { recursive: true, force: true });
  }
});

test("the worker cannot load node:sqlite (denied), while the legitimate fix still passes", async (t: TestContext) => {
  let hostHasSqlite = true;
  try {
    require_("node:sqlite");
  } catch {
    hostHasSqlite = false;
  }
  if (!hostHasSqlite) {
    // Without node:sqlite on the host there is nothing to deny; the denial
    // assertion would pass vacuously, so skip rather than claim a pass.
    t.skip("node:sqlite is not available on this Node runtime; nothing to deny");
    return;
  }

  const parent = await mkdtemp(join(tmpdir(), "gym-iso-hard-"));
  try {
    const repo = await makeRepo(parent, `${BUGGY}// replaced by probe below\n`);
    // `probe` reports whether sqlite loaded; the verifier holds expect "sqlite:no".
    const probeCases: GymCase[] = [
      { module: "./probe.mjs", call: "probe", args: [], expect: "sqlite:no", label: "sqlite denied" },
    ];
    const attack = `${SQLITE_PROBE}\n`;
    const patch = await gitPatch(repo, "probe.mjs", attack);
    const denied = await isolatedScoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: probeCases });
    assert.equal(denied.outcome, "passed", JSON.stringify(denied.cases));

    // Control: a legitimate fix still passes under the same worker flags. A
    // scorer that rejects everything is worthless, so the deny must not break
    // the passing path.
    const fixRepo = await makeRepo(join(parent, "fix"), BUGGY);
    const golden = await patchFor(fixRepo, FIXED);
    const passed = await isolatedScoreGymPatch({ patchText: golden, baseRepoDir: fixRepo, cases: CASES });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.cases));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function patchFor(repo: string, lib: string): Promise<string> {
  await writeFile(join(repo, "lib.mjs"), lib);
  const patch = await git(repo, "diff");
  await git(repo, "reset", "--hard", "-q", "HEAD");
  return patch;
}

async function gitPatch(repo: string, path: string, content: string): Promise<string> {
  await writeFile(join(repo, path), content);
  await git(repo, "add", "-A");
  const patch = await git(repo, "diff", "--cached", "HEAD");
  await git(repo, "reset", "-q", "HEAD");
  await git(repo, "checkout", "--", ".");
  return patch;
}
