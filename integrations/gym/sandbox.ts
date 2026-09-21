/**
 * Build the sandbox-backed `EffectRunner` for the gym's `runner=sandbox` mode.
 *
 * ONE RUNG: all effects — `workspace.read/write/replace/list` AND
 * `process.exec` — execute inside the runtime's persistent gVisor Pod via
 * `SandboxWorkspaceExecutor`. There is deliberately NO `SyntheticExecutor` on
 * this path: the old parallel broker ran workspace effects in worker RAM and
 * only escalated `process.exec`, so the model-authored workspace was not
 * boundary-enforced. The `MemoryWorkspace` here is only the seed/checkpoint
 * cache; the pod's filesystem is the medium. (The synthetic/cheap rung and the
 * labelled `local` control arm still exist elsewhere, but are never the medium
 * for a scored sandboxed run.)
 *
 * A `LocalDirSource` is a read-only `TreeSource` over the materialized bugged
 * checkout; the synchronizer materializes it into the Pod once and commits it as
 * the git baseline harvest diffs against.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  ExecutionBroker,
  KubectlSandboxBackend,
  LocalRuntimeStateStore,
  MemoryWorkspace,
  SandboxWorkspaceExecutor,
  brokerEffectRunner,
  type Effect,
  type EffectContext,
  type EffectResult,
  type KubernetesResourceClass,
  type SandboxBackend,
  type SourceInfo,
  type TreeSource,
  type WorkspaceRevision,
  type EffectRunner,
} from "../../src/index.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);

class LocalDirSource implements TreeSource {
  readonly name: string;
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    this.name = `local-dir:${root}`;
  }

  async revision(): Promise<WorkspaceRevision> {
    return { kind: "unknown", ref: this.#root };
  }

  async stat(path: string): Promise<SourceInfo | undefined> {
    const full = join(this.#root, path);
    try {
      const info = await lstat(full);
      const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file";
      return { path, kind, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return undefined;
    }
  }

  async listDir(path: string): Promise<readonly SourceInfo[]> {
    const full = join(this.#root, path);
    const entries = await readdir(full, { withFileTypes: true });
    const out: SourceInfo[] = [];
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const info = await this.stat(path ? `${path}/${entry.name}` : entry.name);
      if (info) out.push(info);
    }
    return out;
  }

  async readFile(path: string): Promise<Uint8Array> {
    return readFile(join(this.#root, path));
  }

  async *listFiles(): AsyncIterable<string> {
    const root = this.#root;
    const walk = async function* (dir: string): AsyncGenerator<string> {
      const full = join(root, dir);
      for (const entry of await readdir(full, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) yield* walk(rel);
        else yield rel;
      }
    };
    yield* walk("");
  }
}

export interface BuildSandboxRunnerOptions {
  /** Materialized bugged checkout (its tracked tree is materialized into the Pod). */
  repoDir: string;
  /**
   * node+git-capable image pinned by digest. The Pod runs the agent's
   * `run_visible_test`, so it must have node as well as git — a git-only image
   * such as `alpine/git` makes the tool exit 127. Example:
   * `docker.io/library/node:22-bookworm@sha256:dd5847a0...`.
   */
  image: string;
  namespace?: string;
  kubectlContext?: string;
  runtimeClassName?: string;
  agentId?: string;
  /** Test seam: a fake "pod" backend instead of kubectl. */
  backend?: SandboxBackend;
  /** Test seam: override the resource class. */
  resourceClass?: KubernetesResourceClass;
}

export interface SandboxRunner {
  runner: EffectRunner;
  /**
   * Execute an execution-rung effect through the broker (the same path the
   * runtime turn's `executeEffect` uses). Every workspace effect and
   * `process.exec` runs in the pod.
   */
  executeEffect(effect: Effect, minFidelity?: number): Promise<EffectResult>;
  close(): Promise<void>;
}

/**
 * Persistent runners, keyed by attempt (agent + checkpoint key). A turn-per-
 * activity loop runs each turn in a fresh activity, so the pod that holds the
 * agent's edits must outlive one activity: this map is that continuity for the
 * lifetime of the worker process. Across a worker restart the map is cold and
 * the caller restores from the attempt checkpoint (see `gym-activities.ts`).
 */
const persistentRunners = new Map<string, SandboxRunner>();

export function hasPersistentSandboxRunner(key: string): boolean {
  return persistentRunners.has(key);
}

/** Close and forget the runner for `key` (destroys its pod). */
export async function releasePersistentSandboxRunner(key: string): Promise<void> {
  const runner = persistentRunners.get(key);
  persistentRunners.delete(key);
  await runner?.close().catch(() => {});
}

/** Reuse the runner for `key` if it exists, else build and cache it. */
export async function getPersistentSandboxRunner(options: BuildSandboxRunnerOptions & { key: string }): Promise<SandboxRunner> {
  const existing = persistentRunners.get(options.key);
  if (existing) return existing;
  const built = await buildSandboxRunner(options);
  persistentRunners.set(options.key, built);
  return built;
}

/** Construct the broker-backed runner. Throws if the image is missing. */
export async function buildSandboxRunner(options: BuildSandboxRunnerOptions): Promise<SandboxRunner> {
  if (!options.image && !options.resourceClass) throw new Error("buildSandboxRunner requires a node+git image pinned by digest (the Pod runs run_visible_test)");
  const base = options.resourceClass ?? DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small");
  if (!base) throw new Error("sandbox-small resource class missing");
  const resourceClass: KubernetesResourceClass = {
    ...base,
    ...(options.image ? { image: options.image } : {}),
    ...(options.runtimeClassName ? { runtimeClassName: options.runtimeClassName } : {}),
    warmPool: undefined,
  };

  const backend = options.backend ?? new KubectlSandboxBackend({
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.kubectlContext ? { context: options.kubectlContext } : {}),
  });
  const workspace = new MemoryWorkspace({ source: new LocalDirSource(options.repoDir) });
  const workspaces = new Map([[workspace.id, workspace]]);
  // The one rung: no SyntheticExecutor. The pod's filesystem is the medium for
  // workspace effects as well as process.exec.
  const executor = new SandboxWorkspaceExecutor({ resourceClass, backend, workspaces });
  const broker = new ExecutionBroker([executor], new LocalRuntimeStateStore());
  const context: EffectContext = {
    agentId: (options.agentId ?? "gym-agent") as never,
    workspaceId: workspace.id,
  };
  const raw = brokerEffectRunner(broker, context, "sandbox");
  const repoRoot = options.repoDir;
  // `runGymAttempt` passes host absolute paths (`task.repoDir`) as `cwd` for its
  // git commands (harvest, checkpoint restore). Inside the pod the workspace
  // root IS the repo, so translate that path to the workspace root; any path
  // under it becomes workspace-relative.
  const translatedCwd = (cwd: string | undefined): string | undefined => {
    if (cwd === undefined) return undefined;
    if (cwd === repoRoot) return undefined;
    const rel = relative(repoRoot, cwd);
    if (rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes("..")) return rel;
    return cwd;
  };
  const runner: EffectRunner = {
    ...raw,
    async exec(command, options_ = {}) {
      const cwd = translatedCwd(options_.cwd);
      return raw.exec(command, cwd === undefined ? { ...options_, cwd: undefined } : { ...options_, cwd });
    },
  };
  return {
    runner,
    executeEffect: (effect, minFidelity) => broker.execute(effect, context, minFidelity),
    async close() {
      await executor.close();
    },
  };
}
