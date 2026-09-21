/**
 * Comprehensive adversarial sweep of every channel the scoring worker can use.
 *
 * The FORGE file covers the specific forgeries that broke previous designs; this
 * file enumerates the CHANNELS the review's channel inventory named, one test
 * per family, and asserts the discriminating quantity: the worker cannot use the
 * channel (the probe returns the verifier's sentinel because every attempt is
 * denied), while a legitimate fix still passes.
 *
 * Closed here (verified on this runtime, Node 22):
 *   - environment: the worker gets a MINIMAL env, so no parent secret
 *     (`SYNTH_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, `MY_API_TOKEN`, ...), no
 *     `GYM_HIDDEN_*` and no `NODE_TEST_CONTEXT` reaches agent code.
 *   - filesystem: absolute, `/proc/self/*`, `/proc/<ppid>/*`, `/etc/passwd`, the
 *     fixture tree, `fs.promises`, `process.getBuiltinModule("node:fs")`,
 *     `require`/`import` outside and the scorer's own source.
 *   - symlinks: a leaf, a chain, a relative climbing target and an intermediate
 *     symlinked directory to the held-out vectors are all `tampered` before the
 *     worker runs.
 *   - builtins: `process.binding`, `node:worker_threads`, `module.register` and
 *     `node:sqlite` are denied.
 *   - process creation and writes: `child_process` (exec/spawn/fork) and any
 *     write (inside the clone, the host `/tmp`, `/etc`) are denied.
 *
 * Deliberately NOT here: the channels Node's permission model does not cover at
 * all — network (TCP/UDP/unix sockets/DNS), `node:test`'s `run({files})`,
 * `process.kill` against the verifier, and `os.userInfo`/`hostname` metadata.
 * Those are open holes recorded in docs/KNOWN-OPEN.md with their probe evidence;
 * a test asserting they are closed cannot pass, and a test asserting they are
 * open is not a regression guard. The real boundary for them is the gVisor pod
 * (asserted live in gym-sandbox-boundary.test.ts), not this host worker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isolatedScoreGymPatch, scoreGymPatch, type GymCase, type GymCaseResult } from "../src/index.js";

const execFileAsync = promisify(execFile);

/** The source checkout; the compiled test runs from dist/test, so `../../` is the root. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VECTORS = join(REPO_ROOT, "test/fixtures/gym-tasks/he/decimal-option/hidden.cases.json");
const VECTORS_DIR = join(REPO_ROOT, "test/fixtures/gym-tasks/he/decimal-option");
const SCORER_SOURCE = join(REPO_ROOT, "src/gym/scoring.ts");

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

async function makeRepo(parent: string, files: Record<string, string>): Promise<string> {
  const repo = join(parent, "repo");
  await mkdir(repo, { recursive: true });
  for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
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

/**
 * Every probe function returns exactly the sentinel `"denied"` when the channel
 * is blocked and `"open:<what it reached>"` when it is not. The verifier holds
 * `expect: "denied"` for each call, so a test passes only if the worker executed
 * the module successfully AND every attempt was refused.
 */
function probeModule(body: string): string {
  return [
    'import * as fs from "node:fs";',
    'import { createRequire } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    "const require = createRequire(import.meta.url);",
    "const seen = (value) => (value === undefined || value === null ? \"denied\" : \"open:\" + String(value).slice(0, 64));",
    "const attempt = (fn) => { try { return seen(fn()); } catch { return \"denied\"; } };",
    "const attemptAsync = async (fn) => { try { return seen(await fn()); } catch { return \"denied\"; } };",
    body,
  ].join("\n");
}

/** Run a probe module through the real scorer and assert every case is denied. */
async function assertAllDenied(parent: string, source: string, calls: string[], context: string): Promise<GymCaseResult[]> {
  const repo = await makeRepo(parent, { "probe.mjs": source });
  const cases: GymCase[] = calls.map((call) => ({ module: "./probe.mjs", call, args: [], expect: "denied", label: call }));
  const score = await isolatedScoreGymPatch({ patchText: "", baseRepoDir: repo, cases });
  assert.equal(score.outcome, "passed", `${context}: every channel must be denied, got ${JSON.stringify(score.cases)}`);
  for (const result of score.cases) assert.ok(result.ok, `${context}: ${result.label}: ${result.error}`);
  return score.cases;
}

test("CHANNELS env: the worker inherits no parent secret, no GYM_HIDDEN_*, no NODE_TEST_CONTEXT", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-chan-env-"));
  const secrets: Record<string, string> = {
    SYNTH_GATEWAY_API_KEY: "gateway-secret",
    OPENROUTER_API_KEY: "openrouter-secret",
    MY_API_TOKEN: "generic-secret",
    GYM_HIDDEN_NONCE: "nonce",
    GYM_HIDDEN_KEY_FILE: "/tmp/key",
    GYM_HIDDEN_RESULT_FILE: "/tmp/result",
    NODE_TEST_CONTEXT: "1",
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(secrets)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const source = probeModule(
      [
        "export function envLeak() {",
        `  const names = ${JSON.stringify(Object.keys(secrets))};`,
        "  const visible = names.filter((key) => process.env[key] !== undefined);",
        '  return visible.length === 0 ? "denied" : "open:" + visible.join(",");',
        "}",
      ].join("\n"),
    );
    await assertAllDenied(parent, source, ["envLeak"], "env leak");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(parent, { recursive: true, force: true });
  }
});

test("CHANNELS fs: absolute, /proc, /etc, the fixture tree and the scorer source are all unreadable", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-chan-fs-"));
  try {
    const outsideModule = join(parent, "outside.mjs");
    await writeFile(outsideModule, "export const secret = 'outside-module';\n");
    const source = probeModule(
      [
        `const V = ${JSON.stringify(VECTORS)};`,
        `const DIR = ${JSON.stringify(VECTORS_DIR)};`,
        `const ROOT = ${JSON.stringify(REPO_ROOT)};`,
        `const SCORER = ${JSON.stringify(SCORER_SOURCE)};`,
        `const OUTSIDE_MODULE = ${JSON.stringify(outsideModule)};`,
        "export function readAbsolute() { return attempt(() => fs.readFileSync(V, 'utf8').length); }",
        "export function readProcSelfEnviron() { return attempt(() => fs.readFileSync('/proc/self/environ', 'utf8').length); }",
        "export function readProcSelfMaps() { return attempt(() => fs.readFileSync('/proc/self/maps', 'utf8').length); }",
        "export function readProcSelfCwd() { return attempt(() => fs.readlinkSync('/proc/self/cwd')); }",
        "export function readProcSelfRoot() { return attempt(() => fs.readlinkSync('/proc/self/root')); }",
        "export function readProcPpidCwd() { return attempt(() => fs.readlinkSync('/proc/' + process.ppid + '/cwd')); }",
        "export function readProcPpidRoot() { return attempt(() => fs.readlinkSync('/proc/' + process.ppid + '/root')); }",
        "export function readProcPpidEnviron() { return attempt(() => fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8').length); }",
        "export function readProcPpidCmdline() { return attempt(() => fs.readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').length); }",
        "export function readEtcPasswd() { return attempt(() => fs.readFileSync('/etc/passwd', 'utf8').length); }",
        "export function readScorerSource() { return attempt(() => fs.readFileSync(SCORER, 'utf8').length); }",
        "export function readFixtureDir() { return attempt(() => fs.readdirSync(DIR).length); }",
        "export function walkFixtureTree() { return attempt(() => fs.readdirSync(ROOT, { recursive: true }).length); }",
        "export function statOutside() { return attempt(() => fs.statSync('/etc/hostname').size); }",
        "export function accessOutside() { return attempt(() => { fs.accessSync('/etc/shadow'); return 'reached'; }); }",
        "export function getBuiltinRead() { return attempt(() => process.getBuiltinModule('node:fs').readFileSync(V, 'utf8').length); }",
        "export function requireVectors() { return attempt(() => Object.keys(require(V)).length); }",
        "export function requireOutsideModule() { return attempt(() => Object.keys(require(OUTSIDE_MODULE)).length); }",
        "export async function promisesRead() { return attemptAsync(() => fs.promises.readFile(V, 'utf8').then((text) => text.length)); }",
        "export async function importVectors() { return attemptAsync(() => import(pathToFileURL(V).href).then((mod) => Object.keys(mod).length)); }",
        "export async function importOutsideModule() { return attemptAsync(() => import(pathToFileURL(OUTSIDE_MODULE).href).then((mod) => Object.keys(mod).length)); }",
        "export async function walkFoundVectors() {",
        "  return attemptAsync(async () => {",
        "    const entries = await fs.promises.readdir(ROOT, { recursive: true });",
        "    return entries.find((entry) => String(entry).endsWith('hidden.cases.json')) ?? 'readdir-succeeded';",
        "  });",
        "}",
      ].join("\n"),
    );
    await assertAllDenied(
      parent,
      source,
      [
        "readAbsolute",
        "readProcSelfEnviron",
        "readProcSelfMaps",
        "readProcSelfCwd",
        "readProcSelfRoot",
        "readProcPpidCwd",
        "readProcPpidRoot",
        "readProcPpidEnviron",
        "readProcPpidCmdline",
        "readEtcPasswd",
        "readScorerSource",
        "readFixtureDir",
        "walkFixtureTree",
        "statOutside",
        "accessOutside",
        "getBuiltinRead",
        "requireVectors",
        "requireOutsideModule",
        "promisesRead",
        "importVectors",
        "importOutsideModule",
        "walkFoundVectors",
      ],
      "filesystem",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("CHANNELS builtins: process.binding, worker_threads, module.register and node:sqlite are denied", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-chan-builtin-"));
  try {
    const source = probeModule(
      [
        "export function bindingFs() { return attempt(() => typeof process.binding('fs').open); }",
        "export function bindingSpawnSync() { return attempt(() => typeof process.binding('spawn_sync')); }",
        "export function bindingTcpWrap() { return attempt(() => typeof process.binding('tcp_wrap')); }",
        "export function workerThreads() { return attempt(() => { new (require('node:worker_threads').Worker)('', { eval: true }); return 'created'; }); }",
        "export function moduleRegister() { return attempt(() => { require('node:module').register('data:text/javascript,export function resolve(){}'); return 'registered'; }); }",
        "export function sqlite() { return attempt(() => { require('node:sqlite'); return 'loaded'; }); }",
        "export function sqliteGetBuiltin() { return attempt(() => process.getBuiltinModule('node:sqlite')); }",
      ].join("\n"),
    );
    await assertAllDenied(
      parent,
      source,
      ["bindingFs", "bindingSpawnSync", "bindingTcpWrap", "workerThreads", "moduleRegister", "sqlite", "sqliteGetBuiltin"],
      "builtins",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("CHANNELS child/write: child_process and every write outside the read-only work dir are denied", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-chan-child-"));
  try {
    const outside = join(parent, "outside-write.txt");
    const source = probeModule(
      [
        `const OUT = ${JSON.stringify(outside)};`,
        `const V = ${JSON.stringify(VECTORS)};`,
        "export function execSync() { return attempt(() => require('node:child_process').execSync('id', { encoding: 'utf8' }).trim()); }",
        "export function spawnSync() { return attempt(() => require('node:child_process').spawnSync('id', [], { encoding: 'utf8' }).status); }",
        "export function spawn() { return attempt(() => { const child = require('node:child_process').spawn('id'); child.kill(); return 'pid:' + child.pid; }); }",
        "export function fork() { return attempt(() => { const child = require('node:child_process').fork(process.argv[1] ?? 'x'); child.kill(); return 'pid:' + child.pid; }); }",
        "export function writeOutside() { return attempt(() => { fs.writeFileSync(OUT, 'x'); return 'wrote'; }); }",
        "export function writeEtc() { return attempt(() => { fs.writeFileSync('/etc/gym-channel-write', 'x'); return 'wrote'; }); }",
        "export function writeInsideClone() { return attempt(() => { fs.writeFileSync('./owned.txt', 'x'); return 'wrote'; }); }",
        "export function appendProbe() { return attempt(() => { fs.appendFileSync('./probe.mjs', '//x'); return 'appended'; }); }",
        "export function symlinkOutside() { return attempt(() => { fs.symlinkSync(V, './evil'); return 'linked'; }); }",
        "export function getBuiltinWrite() { return attempt(() => { process.getBuiltinModule('node:fs').writeFileSync(OUT, 'x'); return 'wrote'; }); }",
        "export function writeHeapSnapshot() { return attempt(() => { require('node:v8').writeHeapSnapshot(OUT + '.heapsnapshot'); return 'wrote'; }); }",
        "export function processReport() { return attempt(() => { process.report.writeReport(OUT + '.json'); return 'wrote'; }); }",
      ].join("\n"),
    );
    await assertAllDenied(
      parent,
      source,
      [
        "execSync",
        "spawnSync",
        "spawn",
        "fork",
        "writeOutside",
        "writeEtc",
        "writeInsideClone",
        "appendProbe",
        "symlinkOutside",
        "getBuiltinWrite",
        "writeHeapSnapshot",
        "processReport",
      ],
      "child/write",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

/** Stage a patch that plants one symlink (or a chain) and return the patch text. */
async function symlinkPatch(repo: string, plant: (repo: string) => Promise<void>): Promise<string> {
  await writeFile(join(repo, "lib.mjs"), "export function addOne(n) { return n + 1; }\n");
  await plant(repo);
  await git(repo, "add", "-A");
  const patch = await git(repo, "diff", "--cached");
  await git(repo, "reset", "-q", "HEAD");
  await git(repo, "checkout", "--", ".");
  await git(repo, "clean", "-fdq");
  return patch;
}

test("CHANNELS symlink: a chain, a relative climbing target and an intermediate symlinked dir are tampered", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-chan-link-"));
  try {
    const repo = await makeRepo(parent, { "lib.mjs": BUGGY });
    // The clone is <tmp>/gym-isolated-<random>/clone, so the number of `..` to the
    // vectors is fixed even though the work-dir name is random.
    const climbing = relative(join(tmpdir(), "gym-isolated-placeholder", "clone"), VECTORS);

    const patches: Array<{ name: string; patch: string }> = [
      {
        name: "chain",
        patch: await symlinkPatch(repo, async (root) => {
          await symlink(VECTORS, join(root, "escape.json"));
          await symlink("escape.json", join(root, "chain.json"));
        }),
      },
      {
        name: "relative climbing target",
        patch: await symlinkPatch(repo, async (root) => {
          await symlink(climbing, join(root, "climb.json"));
        }),
      },
      {
        name: "intermediate symlinked directory",
        patch: await symlinkPatch(repo, async (root) => {
          await symlink(VECTORS_DIR, join(root, "linked-dir"));
        }),
      },
    ];

    for (const { name, patch } of patches) {
      const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES });
      assert.notEqual(score.outcome, "passed", `${name}: a symlink to the held-out vectors must not pass`);
      assert.equal(score.outcome, "tampered", `${name}: expected tampered, got ${score.outcome} (${score.detail ?? ""})`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("CHANNELS control: the legitimate fix still passes under the same confinement", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gym-chan-control-"));
  try {
    const repo = await makeRepo(parent, { "lib.mjs": BUGGY });
    const golden = await patchFor(repo, FIXED);
    const score = await isolatedScoreGymPatch({ patchText: golden, baseRepoDir: repo, cases: CASES });
    assert.equal(score.outcome, "passed", JSON.stringify(score.cases));

    const wrong = await patchFor(repo, `${BUGGY}// touched\n`);
    assert.equal((await isolatedScoreGymPatch({ patchText: wrong, baseRepoDir: repo, cases: CASES })).outcome, "failed");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
