/**
 * Unforgeable gym scoring: the pass decision is made where the agent's code
 * cannot run, reach or observe it.
 *
 * The previous scorer ran the hidden test in the SAME process as agent code
 * (the test imports the module under test), so agent code could read a nonce
 * out of its own environment or `process.exit(0)` before the runner registered a
 * subtest, and be scored `passed` with the bug unfixed. This module removes that
 * capability entirely:
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
 *   - Zero cases is `errored`, not a vacuous pass.
 *
 * This deliberately does not edit `src/gym/scoring.ts`: it is a separate,
 * additive decision so it can be ported or superseded without conflict.
 */
import { execFile } from "node:child_process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type { GymOutcome } from "./scoring.js";
import { isTampering, patchTargetPaths } from "./scoring.js";

const execFileAsync = promisify(execFile);

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

    child = spawn(options.nodeBin ?? process.execPath, [workerPath], {
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

/**
 * Adapt an isolated-case score to the `GymScorer` seam used by `runGymAttempt`.
 * `baseRepoDir` must be the BUGGED checkout; the verifier clones it.
 */
export function isolatedScorerFor(cases: readonly GymCase[], nodeBin?: string): (request: { patchText: string; baseRepoDir: string }) => Promise<IsolatedScore> {
  return (request) => isolatedScoreGymPatch({ ...request, cases, ...(nodeBin ? { nodeBin } : {}) });
}
