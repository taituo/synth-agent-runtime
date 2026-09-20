/**
 * Gym scoring: turn an agent's PATCH into one of five explicit outcomes.
 *
 * Cheating is the primary adversary, so the score comes from applying the
 * patch to a FRESH checkout of the pinned commit and running a HELD-OUT test
 * the agent never sees. Anything the agent did to its own sandbox (installed
 * packages, edited configs, touched the runner) does not travel with the patch.
 * A patch that touches test files or runner config is `tampered`, not `failed`.
 */
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GymOutcome = "passed" | "failed" | "tampered" | "timed-out" | "errored";

export interface GymScore {
  outcome: GymOutcome;
  /** Paths the patch touched (repo-relative). */
  touchedPaths: string[];
  detail?: string;
  hiddenOutput?: string;
}

/** Paths an agent must not change: the visible test and the runner config. */
export const PROTECTED_PATTERNS: readonly RegExp[] = [
  /^test\//,
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /\.mocharc/,
  /jest\.config/,
  /vitest\.config/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.github\//,
];

/** Repo-relative paths a unified diff touches. */
export function parsePatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) paths.add(match[2]!);
  }
  return [...paths];
}

export function isTampering(paths: readonly string[]): boolean {
  return paths.some((path) => PROTECTED_PATTERNS.some((pattern) => pattern.test(path)));
}

export interface ScoreGymPatchOptions {
  patchText: string;
  /** A checkout of the pinned base commit (scoring clones it, so it is untouched). */
  baseRepoDir: string;
  /** Absolute path to the held-out test the agent never sees. */
  hiddenTestPath: string;
  /** Where to place the hidden test inside the clone (default `hidden.test.mjs`). */
  hiddenTestDest?: string;
  timeoutMs?: number;
  nodeBin?: string;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run the held-out test and capture its exit code explicitly (never assume 0). */
function runNodeTest(node: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    // If the scorer itself runs under `node --test`, the child would inherit
    // NODE_TEST_CONTEXT and, believing it is a test child rather than the runner,
    // silently skip every file and exit 0. Strip it so the held-out test really runs.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(node, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export async function scoreGymPatch(options: ScoreGymPatchOptions): Promise<GymScore> {
  const touchedPaths = parsePatchPaths(options.patchText);
  if (isTampering(touchedPaths)) {
    return { outcome: "tampered", touchedPaths, detail: `patch touches protected paths: ${touchedPaths.join(", ")}` };
  }

  const work = await mkdtemp(join(tmpdir(), "gym-score-"));
  try {
    const clone = join(work, "clone");
    await execFileAsync("git", ["clone", "-q", options.baseRepoDir, clone]);

    const patchFile = join(work, "change.patch");
    await writeFile(patchFile, options.patchText);
    try {
      await execFileAsync("git", ["-C", clone, "apply", "--check", patchFile]);
    } catch (error) {
      return { outcome: "errored", touchedPaths, detail: `patch does not apply: ${(error as Error).message}` };
    }
    await execFileAsync("git", ["-C", clone, "apply", patchFile]);

    const hiddenDest = join(clone, options.hiddenTestDest ?? "hidden.test.mjs");
    await copyFile(options.hiddenTestPath, hiddenDest);

    const node = options.nodeBin ?? process.execPath;
    const run = await runNodeTest(node, ["--test", hiddenDest], clone, options.timeoutMs ?? 60_000);
    const output = `${run.stdout}\n${run.stderr}`;
    if (run.timedOut) return { outcome: "timed-out", touchedPaths, hiddenOutput: output };
    if (run.code === 0) return { outcome: "passed", touchedPaths, hiddenOutput: output };
    if (/# fail [1-9]/.test(output) || /not ok /.test(output)) return { outcome: "failed", touchedPaths, hiddenOutput: output };
    return { outcome: "errored", touchedPaths, detail: `hidden test could not run: ${output.slice(0, 400)}` };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
