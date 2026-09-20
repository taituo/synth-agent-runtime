/**
 * Build the sandbox-backed `EffectRunner` both gym arms use.
 *
 * The plain arm and the durable arm must differ in exactly one variable —
 * durability — so both drive the same tools over a gVisor/Kubernetes sandbox.
 * This mirrors `integrations/kubernetes/mixed-chain.ts`: a `MemoryWorkspace`
 * backed by a local checkout, a `SyntheticExecutor` for workspace effects and a
 * `KubernetesExecutor` for `process.exec`, fronted by an `ExecutionBroker` with
 * per-effect receipts.
 *
 * The `LocalDirSource` is a read-only `TreeSource` over the materialized bugged
 * checkout; it is what the synchronizer materializes into the Pod and commits as
 * the git baseline harvest diffs against.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  ExecutionBroker,
  KubernetesExecutor,
  KubectlSandboxBackend,
  LocalRuntimeStateStore,
  MemoryWorkspace,
  SyntheticExecutor,
  brokerEffectRunner,
  type EffectContext,
  type KubernetesResourceClass,
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
  /** Git-capable image pinned by digest (e.g. alpine/git@sha256:...). */
  image: string;
  namespace?: string;
  kubectlContext?: string;
  runtimeClassName?: string;
  agentId?: string;
}

export interface SandboxRunner {
  runner: EffectRunner;
  close(): Promise<void>;
}

/** Construct the broker-backed runner. Throws if the image is missing. */
export async function buildSandboxRunner(options: BuildSandboxRunnerOptions): Promise<SandboxRunner> {
  if (!options.image) throw new Error("buildSandboxRunner requires a git-capable image pinned by digest");
  const base = DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small");
  if (!base) throw new Error("sandbox-small resource class missing");
  const resourceClass: KubernetesResourceClass = {
    ...base,
    image: options.image,
    ...(options.runtimeClassName ? { runtimeClassName: options.runtimeClassName } : {}),
    warmPool: undefined,
  };

  const backend = new KubectlSandboxBackend({
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.kubectlContext ? { context: options.kubectlContext } : {}),
  });
  const workspace = new MemoryWorkspace({ source: new LocalDirSource(options.repoDir) });
  const workspaces = new Map([[workspace.id, workspace]]);
  const synthetic = new SyntheticExecutor(workspaces);
  const real = new KubernetesExecutor({ resourceClass, backend, workspaces });
  const broker = new ExecutionBroker([synthetic, real], new LocalRuntimeStateStore());
  const context: EffectContext = {
    agentId: (options.agentId ?? "gym-agent") as never,
    workspaceId: workspace.id,
  };
  const runner = brokerEffectRunner(broker, context, "sandbox");
  return {
    runner,
    async close() {
      // Each broker exec is one-shot: the KubernetesExecutor destroys its Pod.
    },
  };
}
