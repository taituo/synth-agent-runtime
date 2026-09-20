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
export declare const PROTECTED_PATTERNS: readonly RegExp[];
/**
 * Every path-like token a unified diff mentions, taking BOTH sides of a rename
 * or copy and the `---`/`+++` headers as well as the `diff --git` line. Taking
 * only the `b/` side of `diff --git` misses a rename that moves a protected file
 * away under a new name, and a hand-crafted patch can omit the `diff --git`
 * header entirely while still applying. Over-reporting is safe here: an extra
 * path can only make the tampering check stricter.
 */
export declare function parsePatchPaths(patchText: string): string[];
/**
 * Repo-relative paths a patch targets, according to git's own patch parser.
 * `git apply --numstat` lists what a patch will touch even when it would not
 * apply (wrong context) and even without a `diff --git` header, and it decodes
 * git's quoted/octal-escaped paths. The raw parse is unioned in to catch the
 * original name of a rename, which `--numstat` reports only under the new name.
 */
export declare function patchTargetPaths(patchText: string): Promise<string[]>;
export declare function isTampering(paths: readonly string[]): boolean;
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
export declare const WORKER_SOURCE = "\nimport { createRequire } from \"node:module\";\nimport { resolve } from \"node:path\";\nimport { createInterface } from \"node:readline\";\nimport { pathToFileURL } from \"node:url\";\nimport { readFileSync, writeFileSync, writeSync } from \"node:fs\";\n\nconst reply = (message) => writeSync(3, JSON.stringify(message) + \"\\n\");\nconst cache = new Map();\nconst require = createRequire(import.meta.url);\n\nconst load = async (spec) => {\n  if (cache.has(spec)) return cache.get(spec);\n  const path = resolve(spec);\n  let mod;\n  try {\n    mod = await import(pathToFileURL(path).href);\n  } catch {\n    mod = { default: require(path) };\n  }\n  cache.set(spec, mod);\n  return mod;\n};\n\n// One-shot batch mode for a sandboxed exec: read every request up front, write\n// every result, exit. Same evaluation, no interactive fd required, so the\n// worker can run inside a one-shot pod exec under the execution rung. Expected\n// values are still never passed in; only module/call/args are.\nconst requestsPath = process.argv[2];\nif (requestsPath) {\n  const resultsPath = process.argv[3];\n  const requests = JSON.parse(readFileSync(requestsPath, \"utf8\"));\n  const results = [];\n  for (const request of requests) {\n    try {\n      const mod = await load(request.module);\n      const fn = mod[request.call] ?? mod.default?.[request.call];\n      if (typeof fn !== \"function\") throw new Error(\"no exported function \" + request.call);\n      const value = await fn(...(request.args ?? []));\n      results.push({ id: request.id, present: value !== undefined, valueJson: JSON.stringify(value) });\n    } catch (error) {\n      results.push({ id: request.id, error: String(error && error.message ? error.message : error) });\n    }\n  }\n  writeFileSync(resultsPath, JSON.stringify(results));\n  process.exit(0);\n}\n\nconst rl = createInterface({ input: process.stdin });\nfor await (const line of rl) {\n  if (!line.trim()) continue;\n  let request;\n  try {\n    request = JSON.parse(line);\n  } catch {\n    continue;\n  }\n  try {\n    const mod = await load(request.module);\n    const fn = mod[request.call] ?? mod.default?.[request.call];\n    if (typeof fn !== \"function\") throw new Error(\"no exported function \" + request.call);\n    const value = await fn(...(request.args ?? []));\n    reply({ id: request.id, present: value !== undefined, valueJson: JSON.stringify(value) });\n  } catch (error) {\n    reply({ id: request.id, error: String(error && error.message ? error.message : error) });\n  }\n}\n";
/**
 * Apply the agent's patch to a fresh clone and decide `passed`/`failed`/
 * `tampered`/`timed-out`/`errored` from the verifier's own comparison.
 */
export declare function isolatedScoreGymPatch(options: IsolatedScoreOptions): Promise<IsolatedScore>;
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
export declare function scoreGymPatch(options: ScoreGymPatchOptions): Promise<GymScore>;
/**
 * Adapt an isolated-case score to a `GymScorer` seam. `baseRepoDir` must be the
 * BUGGED checkout; the verifier clones it.
 */
export declare function isolatedScorerFor(cases: readonly GymCase[], nodeBin?: string): (request: {
    patchText: string;
    baseRepoDir: string;
}) => Promise<IsolatedScore>;
