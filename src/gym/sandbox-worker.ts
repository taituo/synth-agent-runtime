/**
 * The OS-level boundary for the scoring worker.
 *
 * The worker runs the agent's module, so it is untrusted. On the host it is
 * only confined by Node's permission model — a guardrail that does not gate
 * every builtin and cannot stop network or process access (`node:sqlite` was
 * one measured escape; review round six). Here the worker instead runs as a
 * one-shot `node worker.mjs requests.json results.json` inside the same
 * Kubernetes + gVisor pod the execution rung already trusts:
 *
 *   - only the applied checkout is materialized into the pod (no host mounts,
 *     no host `/tmp`, no `.git`, no `node_modules`);
 *   - the pod's network policy allows DNS egress only, and the pod has its own
 *     network and PID namespaces, so it cannot reach Temporal/Postgres, signal
 *     the verifier, or read host metadata;
 *   - the verifier still holds the held-out cases: the requests file carries
 *     only module/call/args and never an expected value, and the comparison
 *     happens back on the trusted side.
 *
 * Node's permission-model deny flags stay on when a host worker is used, but
 * they are not the boundary.
 */
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_KUBERNETES_RESOURCE_CLASSES, type KubernetesResourceClass } from "../execution/resource-class.js";
import { KubectlSandboxBackend } from "../execution/kubernetes/kubectl-backend.js";
import { WorkspaceSynchronizer } from "../execution/kubernetes/workspace-sync.js";
import type { SandboxIdentity } from "../execution/kubernetes/types.js";
import { MemoryWorkspace } from "../workspace/memory-workspace.js";
import type { GymCase, GymCaseResult, GymOutcome } from "./scoring.js";

export interface SandboxScorerConfig {
  image: string;
  namespace?: string;
  runtimeClassName?: string;
  kubectlContext?: string;
}

export interface SandboxScoreOptions {
  /** A checkout with the agent's patch already applied (the verifier's clone). */
  cloneDir: string;
  cases: readonly GymCase[];
  /** The worker program to run in the pod (`WORKER_SOURCE`). */
  workerSource: string;
  timeoutMs: number;
  config: SandboxScorerConfig;
}

export interface SandboxScoreResult {
  outcome: GymOutcome;
  cases: GymCaseResult[];
  detail?: string;
}

/**
 * The configured OS boundary, or undefined when no cluster image is set. A
 * deployment sets `SYNTH_EXECUTOR_IMAGE` (and optionally
 * `SYNTH_SCORER_NAMESPACE` / `SYNTH_RUNTIME_CLASS` / `SYNTH_KUBERNETES_CONTEXT`);
 * `SYNTH_SCORER_SANDBOX=0` forces the host path for local debugging.
 */
export function sandboxScorerConfig(): SandboxScorerConfig | undefined {
  if (process.env.SYNTH_SCORER_SANDBOX === "0") return undefined;
  const image = process.env.SYNTH_EXECUTOR_IMAGE;
  if (!image) return undefined;
  return {
    image,
    ...(process.env.SYNTH_SCORER_NAMESPACE ? { namespace: process.env.SYNTH_SCORER_NAMESPACE } : {}),
    ...(process.env.SYNTH_RUNTIME_CLASS ? { runtimeClassName: process.env.SYNTH_RUNTIME_CLASS } : {}),
    ...(process.env.SYNTH_KUBERNETES_CONTEXT ? { kubectlContext: process.env.SYNTH_KUBERNETES_CONTEXT } : {}),
  };
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Read the applied checkout into an in-memory tree the synchronizer writes. */
async function materializeClone(workspace: MemoryWorkspace, root: string, rel = ""): Promise<void> {
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    const full = join(root, rel, entry.name);
    if (entry.isSymbolicLink()) {
      workspace.symlink(path, await readlink(full));
    } else if (entry.isDirectory()) {
      await materializeClone(workspace, root, path);
    } else if (entry.isFile()) {
      workspace.write(path, await readFile(full));
    }
  }
}

function resourceClassFor(config: SandboxScorerConfig): KubernetesResourceClass {
  const base = DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small");
  if (!base) throw new Error("sandbox-small resource class is missing");
  return {
    ...base,
    image: config.image,
    ...(config.runtimeClassName ? { runtimeClassName: config.runtimeClassName } : {}),
  };
}

/**
 * Score by running the worker in the gVisor pod. Returns `errored`/`timed-out`
 * outcomes for infrastructure failures; the caller wraps this and never lets it
 * throw.
 */
export async function scoreInSandbox(options: SandboxScoreOptions): Promise<SandboxScoreResult> {
  const backend = new KubectlSandboxBackend({
    ...(options.config.namespace ? { namespace: options.config.namespace } : {}),
    ...(options.config.kubectlContext ? { context: options.config.kubectlContext } : {}),
  });
  let sandbox: SandboxIdentity | undefined;
  try {
    sandbox = await backend.create(resourceClassFor(options.config));
    const workspace = new MemoryWorkspace();
    await materializeClone(workspace, options.cloneDir);
    // No git baseline: scoring never syncs back, and the baseline adds nothing.
    await new WorkspaceSynchronizer(backend, { initializeGitBaseline: false }).materialize(workspace, sandbox);

    // The worker source is the same one the host path runs; batch mode reads the
    // requests file and writes the results file. Expected values are NOT here.
    const requests = options.cases.map((testCase, index) => ({
      id: index + 1,
      module: testCase.module,
      call: testCase.call,
      args: testCase.args,
    }));
    await backend.writeFile(sandbox, "worker.mjs", new TextEncoder().encode(options.workerSource));
    await backend.writeFile(sandbox, "requests.json", new TextEncoder().encode(JSON.stringify(requests)));

    // The backend's default cwd is /workspace (a `cwd` is resolved relative to
    // it, so passing "/workspace" would become /workspace/workspace).
    const run = await backend.exec(sandbox, {
      command: "node worker.mjs requests.json results.json",
      timeoutMs: Math.max(options.timeoutMs, 5_000) * options.cases.length + 30_000,
    });

    let parsed: Array<{ id: number; present?: boolean; valueJson?: string; error?: string }>;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await backend.readFile(sandbox, "results.json"))) as typeof parsed;
    } catch {
      return {
        outcome: run.timedOut ? "timed-out" : "errored",
        cases: [],
        detail: run.timedOut ? "the sandboxed worker timed out" : `the sandboxed worker wrote no results (exit ${run.exitCode}): ${(run.stderr || run.stdout).slice(0, 300)}`,
      };
    }

    let sawError = false;
    const caseResults: GymCaseResult[] = options.cases.map((testCase, index) => {
      const label = testCase.label ? { label: testCase.label } : {};
      const response = parsed.find((entry) => entry.id === index + 1);
      if (!response) {
        sawError = true;
        return { ...label, ok: false, error: "worker returned no result" };
      }
      if (response.error !== undefined) {
        sawError = true;
        return { ...label, ok: false, error: response.error };
      }
      const expectedJson = JSON.stringify(testCase.expect);
      const ok = response.present === true && response.valueJson === expectedJson;
      return { ...label, ok, ...(ok ? {} : { error: `expected ${expectedJson}, got ${response.valueJson ?? "<undefined>"}` }) };
    });

    if (caseResults.every((result) => result.ok)) return { outcome: "passed", cases: caseResults };
    return { outcome: sawError ? "errored" : "failed", cases: caseResults };
  } catch (error) {
    return { outcome: "errored", cases: [], detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (sandbox) await backend.destroy(sandbox).catch(() => {});
  }
}
