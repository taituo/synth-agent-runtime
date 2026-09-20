/**
 * Gym scoring: turn an agent's PATCH into one of six explicit outcomes, with the
 * pass decision made where the agent's code cannot run, reach or observe it.
 *
 * The score comes from applying the patch to a FRESH checkout of the pinned
 * commit and comparing the agent module's returned values to held-out vectors.
 * Anything the agent did to its own sandbox (installed packages, edited configs,
 * touched the runner) does not travel with the patch. A patch that touches test
 * files or runner config is `tampered`, not `failed`.
 *
 * `passed` is NOT "node exited 0", and it is not a signature the agent can mint.
 * A previous design signed an assertion transcript with a per-run key held by a
 * harness written INTO the clone; agent code imported that harness and used it as
 * a signing oracle, producing a genuine MAC over a forged transcript. Any signer
 * that runs in the agent's process is reachable by agent code, so the decision is
 * moved out of that process entirely:
 *
 *   - The verifier (this file) holds the test vectors and the expected outputs.
 *     It never loads agent code and never puts an expected value or a secret
 *     into the child.
 *   - A worker child loads the agent module and evaluates one call per request,
 *     reporting the result on a dedicated fd. It never sees the expected value,
 *     so it can only pass by actually computing it.
 *   - The verdict is the verifier's comparison of returned values against
 *     expected values. The child's exit code is not consulted at all, so
 *     `process.exit(0)` (early exit) is a failure: the worker dies before
 *     answering and the run is `errored`, never `passed`.
 *   - The worker runs under Node's permission model, confined to the scoring
 *     work directory, so it cannot read the held-out vectors off the filesystem
 *     (a worker once found them through `/proc/<ppid>/cwd`). No permission model
 *     is a refusal to run, not a fail-open.
 *   - Zero cases is `errored`, not a vacuous pass.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GymOutcome = "passed" | "failed" | "tampered" | "timed-out" | "errored" | "skipped";

export interface GymScore {
  outcome: GymOutcome;
  /** Paths the patch touched (repo-relative). */
  touchedPaths: string[];
  detail?: string;
  /** Per-case outcomes the verifier compared; the executed artifact behind `passed`. */
  cases?: GymCaseResult[];
}

/** Paths an agent must not change: the visible test and the runner config. */
export const PROTECTED_PATTERNS: readonly RegExp[] = [
  // Any test directory, not just a top-level `test/` (e.g. `tests/`).
  /(^|\/)tests?\//,
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /\.mocharc/,
  /jest\.config/,
  /vitest\.config/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.github\//,
  /(^|\/)\.git\//,
];

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

/**
 * Every path-like token a unified diff mentions, taking BOTH sides of a rename
 * or copy and the `---`/`+++` headers as well as the `diff --git` line. Taking
 * only the `b/` side of `diff --git` misses a rename that moves a protected file
 * away under a new name, and a hand-crafted patch can omit the `diff --git`
 * header entirely while still applying. Over-reporting is safe here: an extra
 * path can only make the tampering check stricter.
 */
export function parsePatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  const add = (raw: string): void => {
    let path = stripQuotes(raw.trim());
    if (!path || path === "/dev/null") return;
    if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
    if (path) paths.add(path);
  };
  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      for (const token of line.slice("diff --git ".length).match(/"[^"]*"|\S+/g) ?? []) add(token);
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      add(line.slice(4));
    } else if (/^(rename|copy) (from|to) /.test(line)) {
      add(line.replace(/^(rename|copy) (from|to) /, ""));
    }
  }
  return [...paths];
}

/**
 * Repo-relative paths a patch targets, according to git's own patch parser.
 * `git apply --numstat` lists what a patch will touch even when it would not
 * apply (wrong context) and even without a `diff --git` header, and it decodes
 * git's quoted/octal-escaped paths. The raw parse is unioned in to catch the
 * original name of a rename, which `--numstat` reports only under the new name.
 */
export async function patchTargetPaths(patchText: string): Promise<string[]> {
  const raw = parsePatchPaths(patchText);
  const dir = await mkdtemp(join(tmpdir(), "gym-paths-"));
  try {
    const file = join(dir, "change.patch");
    await writeFile(file, patchText);
    const { stdout } = await execFileAsync("git", ["apply", "--numstat", "-z", file]);
    const paths = new Set<string>(raw);
    for (const record of stdout.split("\0")) {
      if (!record) continue;
      const fields = record.split("\t");
      if (fields.length >= 3) for (const field of fields.slice(2)) if (field) paths.add(field);
      else if (fields.length === 1) paths.add(fields[0]!);
    }
    return [...paths];
  } catch {
    // git could not parse the patch at all; the raw parse is the best we have and
    // the apply step will surface the real problem as `errored`.
    return raw;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function isTampering(paths: readonly string[]): boolean {
  return paths.some((path) => PROTECTED_PATTERNS.some((pattern) => pattern.test(path)));
}

/** One assertion the verifier holds: call `module[call](...args)` and expect `expect`. */
export interface GymCase {
  /** Repo-relative (or worker-cwd-relative) module path, e.g. "./he.js". */
  module: string;
  call: string;
  args: unknown[];
  expect: unknown;
  label?: string;
}

export interface GymCaseResult {
  label?: string;
  ok: boolean;
  error?: string;
}

export interface IsolatedScore {
  outcome: GymOutcome;
  touchedPaths: string[];
  cases: GymCaseResult[];
  detail?: string;
}

export interface IsolatedScoreOptions {
  patchText: string;
  /** A checkout of the pinned BUGGED commit. Scoring clones it, so it is untouched. */
  baseRepoDir: string;
  cases: readonly GymCase[];
  timeoutMs?: number;
  nodeBin?: string;
}

/** The evaluation worker. Agent code runs here; expected outputs never do. */
const WORKER_SOURCE = `
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { writeSync } from "node:fs";

const reply = (message) => writeSync(3, JSON.stringify(message) + "\\n");
const cache = new Map();
const require = createRequire(import.meta.url);

const load = async (spec) => {
  if (cache.has(spec)) return cache.get(spec);
  const path = resolve(spec);
  let mod;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch {
    mod = { default: require(path) };
  }
  cache.set(spec, mod);
  return mod;
};

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  try {
    const mod = await load(request.module);
    const fn = mod[request.call] ?? mod.default?.[request.call];
    if (typeof fn !== "function") throw new Error("no exported function " + request.call);
    const value = await fn(...(request.args ?? []));
    reply({ id: request.id, present: value !== undefined, valueJson: JSON.stringify(value) });
  } catch (error) {
    reply({ id: request.id, error: String(error && error.message ? error.message : error) });
  }
}
`;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
}

let cachedPermissionFlag: string | undefined;

/**
 * The worker is untrusted agent code, so it must not be able to read the
 * held-out vectors off the filesystem (a worker read `hidden.cases.json` via
 * `/proc/<ppid>/cwd`). Node's permission model confines filesystem reads to the
 * scoring work directory, which contains only the clone and the worker script;
 * the fixture tree and `/proc/<ppid>` are outside it and are denied. If the
 * runtime has no permission model we refuse to run rather than fail open.
 */
async function permissionArgs(node: string, workDir: string): Promise<string[]> {
  const allow = `--allow-fs-read=${workDir}`;
  if (cachedPermissionFlag) return [cachedPermissionFlag, allow];
  for (const flag of ["--permission", "--experimental-permission"]) {
    try {
      await execFileAsync(node, [flag, allow, "-e", "0"], { timeout: 10_000 });
      cachedPermissionFlag = flag;
      return [flag, allow];
    } catch {
      // flag unsupported; try the next spelling
    }
  }
  throw new Error("Node has no permission model; refusing to run the scoring worker unsandboxed");
}

/**
 * Apply the agent's patch to a fresh clone and decide `passed`/`failed`/
 * `tampered`/`timed-out`/`errored` from the verifier's own comparison.
 */
export async function isolatedScoreGymPatch(options: IsolatedScoreOptions): Promise<IsolatedScore> {
  const touchedPaths = await patchTargetPaths(options.patchText);
  if (isTampering(touchedPaths)) {
    return { outcome: "tampered", touchedPaths, cases: [], detail: `patch touches protected paths: ${touchedPaths.join(", ")}` };
  }
  if (options.cases.length === 0) {
    // No test vectors is not a pass: a vacuous run must be a distinct non-pass.
    return { outcome: "errored", touchedPaths, cases: [], detail: "no hidden cases: refusing a vacuous pass" };
  }

  const work = await mkdtemp(join(tmpdir(), "gym-isolated-"));
  const clone = join(work, "clone");
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await execFileAsync("git", ["clone", "-q", options.baseRepoDir, clone]);
    if (options.patchText.trim().length > 0) {
      const patchFile = join(work, "change.patch");
      await writeFile(patchFile, options.patchText);
      try {
        await git(clone, "apply", "--check", patchFile);
      } catch (error) {
        return { outcome: "errored", touchedPaths, cases: [], detail: `patch does not apply: ${(error as Error).message}` };
      }
      await git(clone, "apply", patchFile);
    }

    const workerPath = join(work, "worker.mjs");
    await writeFile(workerPath, WORKER_SOURCE);

    // The child environment carries no secret and no expected output. Strip the
    // nonce name the old scorer leaked, defensively.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^GYM_HIDDEN/i.test(key)) delete env[key];
    delete env.NODE_TEST_CONTEXT;

    const node = options.nodeBin ?? process.execPath;
    const sandbox = await permissionArgs(node, work);
    child = spawn(node, [...sandbox, workerPath], {
      cwd: clone,
      env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    // Drain the worker's stdout/stderr so a chatty module cannot block the
    // process on a full pipe. Agent prints are deliberately not part of the
    // protocol; the verdict channel is fd 3.
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);

    const responses = new Map<number, (message: { id: number; present?: boolean; valueJson?: string; error?: string }) => void>();
    let buffer = "";
    let workerDead = false;
    const protocol = child.stdio[3] as Readable;
    protocol.setEncoding("utf8");
    protocol.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id: number };
          responses.get(message.id)?.(message as never);
        } catch {
          // ignore non-protocol output
        }
      }
    });
    child.once("exit", () => {
      workerDead = true;
      for (const resolve of responses.values()) resolve({ id: -1, error: "worker exited before answering" });
      responses.clear();
    });
    child.once("error", () => {
      workerDead = true;
    });

    const perCaseTimeout = options.timeoutMs ?? 30_000;
    const results: GymCaseResult[] = [];
    let sawError = false;
    for (let index = 0; index < options.cases.length; index++) {
      const testCase = options.cases[index]!;
      if (workerDead) {
        results.push({ ...(testCase.label ? { label: testCase.label } : {}), ok: false, error: "worker exited before answering (early exit is a failure)" });
        sawError = true;
        continue;
      }
      const id = index + 1;
      const response = await new Promise<{ present?: boolean; valueJson?: string; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
          responses.delete(id);
          resolve({ error: "timed out" });
        }, perCaseTimeout);
        responses.set(id, (message) => {
          clearTimeout(timer);
          responses.delete(id);
          resolve(message);
        });
        child!.stdin.write(`${JSON.stringify({ id, module: testCase.module, call: testCase.call, args: testCase.args })}\n`);
      });
      if (response.error !== undefined) {
        results.push({ ...(testCase.label ? { label: testCase.label } : {}), ok: false, error: response.error });
        sawError = true;
        continue;
      }
      const expectedJson = JSON.stringify(testCase.expect);
      const ok = response.present === true && response.valueJson === expectedJson;
      results.push({ ...(testCase.label ? { label: testCase.label } : {}), ok, ...(ok ? {} : { error: `expected ${expectedJson}, got ${response.valueJson ?? "<undefined>"}` }) });
    }

    if (results.every((result) => result.ok)) return { outcome: "passed", touchedPaths, cases: results };
    return { outcome: sawError ? "errored" : "failed", touchedPaths, cases: results };
  } catch (error) {
    return { outcome: "errored", touchedPaths, cases: [], detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (child) {
      child.kill("SIGKILL");
      child.stdin.destroy();
    }
    await rm(work, { recursive: true, force: true });
  }
}

/** The public scorer seam: same shape as before, but the verdict is isolated. */
export interface ScoreGymPatchOptions {
  patchText: string;
  /** A checkout of the pinned base commit (scoring clones it, so it is untouched). */
  baseRepoDir: string;
  /** The held-out vectors the agent never sees; the verifier holds these. */
  cases: readonly GymCase[];
  timeoutMs?: number;
  nodeBin?: string;
}

export async function scoreGymPatch(options: ScoreGymPatchOptions): Promise<GymScore> {
  const result = await isolatedScoreGymPatch(options);
  return {
    outcome: result.outcome,
    touchedPaths: result.touchedPaths,
    cases: result.cases,
    ...(result.detail ? { detail: result.detail } : {}),
  };
}

/**
 * Adapt an isolated-case score to a `GymScorer` seam. `baseRepoDir` must be the
 * BUGGED checkout; the verifier clones it.
 */
export function isolatedScorerFor(cases: readonly GymCase[], nodeBin?: string): (request: { patchText: string; baseRepoDir: string }) => Promise<IsolatedScore> {
  return (request) => isolatedScoreGymPatch({ ...request, cases, ...(nodeBin ? { nodeBin } : {}) });
}
