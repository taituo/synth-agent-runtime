import type { WorkspaceId } from "../../core/ids.js";
import type { BlobStore } from "../../artifacts/blob-store.js";
import { decodeWorkspaceDiff, MemoryWorkspace } from "../../workspace/memory-workspace.js";
import { normalizeRelative } from "../../workspace/source.js";
import type { ArtifactRef, Effect, EffectContext, EffectResult, Executor } from "../types.js";
import type { KubernetesResourceClass } from "../resource-class.js";
import { WORKSPACE_IS_DIRECTORY, WORKSPACE_NOT_FOUND, WORKSPACE_NOT_DIRECTORY, WORKSPACE_PATH_ESCAPES, escapesWorkspace, workspaceError } from "../workspace-errors.js";
import { WarmSandboxPool } from "./pool.js";
import type { SandboxBackend, SandboxIdentity, WarmSandboxLease } from "./types.js";
import { WorkspaceSynchronizer } from "./workspace-sync.js";

const WORKSPACE_EFFECTS = new Set(["workspace.read", "workspace.write", "workspace.list", "workspace.delete"]);

export interface SandboxWorkspaceExecutorOptions {
  resourceClass: KubernetesResourceClass;
  backend: SandboxBackend;
  /**
   * Seed/checkpoint cache only. The pod's filesystem is the medium for a
   * sandboxed run; this workspace is materialized in once and synced back on
   * `checkpoint()`. It is never the read/write medium.
   */
  workspaces?: Map<WorkspaceId, MemoryWorkspace>;
  pool?: WarmSandboxPool;
  synchronizer?: WorkspaceSynchronizer;
  defaultTimeoutMs?: number;
}

interface WorkspaceLease {
  lease: WarmSandboxLease;
  oneShot: boolean;
  materialized: boolean;
}

/**
 * The sandbox rung's executor: `workspace.read/write/list/delete` AND
 * `process.exec` all execute inside a persistent executor Pod, so the
 * model-authored workspace is boundary-enforced rather than living in worker
 * RAM. `MemoryWorkspace` is only the seed/checkpoint cache.
 *
 * The Pod is held for the workspace's lifetime in this worker process, so a
 * write followed by a read sees the same filesystem. Durability across a worker
 * restart comes from `checkpoint()` (sync the pod back into the cache) plus the
 * caller persisting that snapshot via `snapshot-codec` and the blob store; a
 * fresh worker restores the snapshot and materializes it into a new pod.
 */
export class SandboxWorkspaceExecutor implements Executor {
  readonly id: string;
  readonly fidelity: number;
  readonly resourceClassId: string;
  readonly #resourceClass: KubernetesResourceClass;
  readonly #backend: SandboxBackend;
  readonly #workspaces: Map<WorkspaceId, MemoryWorkspace>;
  readonly #pool?: WarmSandboxPool;
  readonly #sync: WorkspaceSynchronizer;
  readonly #defaultTimeoutMs: number;
  readonly #leases = new Map<string, WorkspaceLease>();

  constructor(options: SandboxWorkspaceExecutorOptions) {
    this.#resourceClass = options.resourceClass;
    this.#backend = options.backend;
    this.#workspaces = options.workspaces ?? new Map();
    this.#pool = options.pool;
    this.#sync = options.synchronizer ?? new WorkspaceSynchronizer(options.backend);
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.id = `sandbox-workspace:${options.resourceClass.id}`;
    this.resourceClassId = options.resourceClass.id;
    this.fidelity = options.resourceClass.fidelity;
  }

  canExecute(effect: Effect, context: EffectContext): boolean {
    if (WORKSPACE_EFFECTS.has(effect.kind)) return true;
    if (effect.kind !== "process.exec") return false;
    if (effect.resourceClass && effect.resourceClass !== this.resourceClassId) return false;
    const allowed = context.executionPolicy?.allowedClasses;
    if (allowed && !allowed.includes(this.resourceClassId)) return false;
    return true;
  }

  async execute(effect: Effect, context: EffectContext): Promise<EffectResult> {
    if (!this.canExecute(effect, context)) return { ok: false, error: "ESCALATION_REQUIRED" };
    let lease: WorkspaceLease;
    try {
      lease = await this.#leaseFor(context.workspaceId, context.agentId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const sandbox = lease.lease.sandbox;

    try {
      switch (effect.kind) {
        case "workspace.read": {
          const path = this.#relative(effect.path);
          if (path === undefined) return { ok: false, error: workspaceError(WORKSPACE_PATH_ESCAPES, effect.path) };
          const kind = await this.#kind(sandbox, path);
          if (kind === "missing") return { ok: false, error: workspaceError(WORKSPACE_NOT_FOUND, path) };
          if (kind === "directory") return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, path) };
          return { ok: true, output: await this.#backend.readFile(sandbox, path) };
        }
        case "workspace.write": {
          const path = this.#relative(effect.path);
          if (path === undefined || path === "") return { ok: false, error: workspaceError(WORKSPACE_PATH_ESCAPES, effect.path) };
          const content = typeof effect.content === "string" ? new TextEncoder().encode(effect.content) : effect.content;
          await this.#backend.writeFile(sandbox, path, content);
          return { ok: true };
        }
        case "workspace.delete": {
          const path = this.#relative(effect.path);
          if (path === undefined || path === "") return { ok: false, error: workspaceError(WORKSPACE_PATH_ESCAPES, effect.path) };
          await this.#backend.removePath(sandbox, path);
          return { ok: true };
        }
        case "workspace.list": {
          const path = effect.path === undefined ? "" : this.#relative(effect.path);
          if (path === undefined) return { ok: false, error: workspaceError(WORKSPACE_PATH_ESCAPES, effect.path ?? "") };
          const kind = path === "" ? "directory" : await this.#kind(sandbox, path);
          if (kind === "missing") return { ok: false, error: workspaceError(WORKSPACE_NOT_FOUND, path) };
          if (kind !== "directory") return { ok: false, error: workspaceError(WORKSPACE_NOT_DIRECTORY, path) };
          return { ok: true, output: await this.#list(sandbox, path) };
        }
        case "process.exec": {
          const result = await this.#backend.exec(sandbox, {
            command: effect.command,
            cwd: effect.cwd,
            env: effect.env,
            timeoutMs: effect.timeoutMs,
          });
          return {
            ok: result.exitCode === 0,
            output: {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: result.timedOut ?? false,
              sandboxId: sandbox.id,
              resourceClass: this.resourceClassId,
            },
            ...(result.exitCode === 0 ? {} : { error: result.timedOut ? "EXECUTION_TIMEOUT" : `Command exited ${result.exitCode}` }),
          };
        }
        default:
          return { ok: false, error: "ESCALATION_REQUIRED" };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Sync the pod workspace back into the cache workspace, so the caller can
   * persist a snapshot. Returns false when there is no pod for the workspace.
   */
  async checkpoint(workspaceId: WorkspaceId): Promise<boolean> {
    const entry = this.#leases.get(String(workspaceId));
    const workspace = this.#workspaces.get(workspaceId);
    if (!entry || !workspace) return false;
    await this.#sync.syncBack(workspace, entry.lease.sandbox);
    return true;
  }

  /** True when this executor holds a live pod for the workspace. */
  hasSandbox(workspaceId: WorkspaceId): boolean {
    return this.#leases.has(String(workspaceId));
  }

  /** The seed/checkpoint cache workspace, if one was supplied. */
  workspace(workspaceId: WorkspaceId): MemoryWorkspace | undefined {
    return this.#workspaces.get(workspaceId);
  }

  /** Destroy every held pod. Call at the end of a run. */
  async close(): Promise<void> {
    const leases = [...this.#leases.values()];
    this.#leases.clear();
    for (const entry of leases) await entry.lease.release({ destroy: entry.oneShot || true }).catch(() => {});
  }

  async #leaseFor(workspaceId: WorkspaceId, agentId: string): Promise<WorkspaceLease> {
    const key = String(workspaceId);
    const existing = this.#leases.get(key);
    if (existing) return existing;

    let lease: WarmSandboxLease;
    let oneShot = false;
    if (this.#pool && this.#resourceClass.warmPool) {
      lease = await this.#pool.acquire(this.resourceClassId);
    } else {
      const sandbox = await this.#backend.create(this.#resourceClass, {
        labels: { "synth.openai.dev/agent-id": agentId, "synth.openai.dev/workspace-id": key },
      });
      oneShot = true;
      lease = { sandbox, resourceClass: this.#resourceClass, release: async (options) => { if (options?.destroy !== false) await this.#backend.destroy(sandbox); } };
    }
    const entry: WorkspaceLease = { lease, oneShot, materialized: false };
    this.#leases.set(key, entry);

    // Materialize the seed/checkpoint cache into the pod once, so a restored
    // snapshot resumes the same workspace state in the sandbox.
    const workspace = this.#workspaces.get(workspaceId);
    if (workspace) await this.#sync.materialize(workspace, lease.sandbox);
    entry.materialized = true;
    return entry;
  }

  async #kind(sandbox: SandboxIdentity, path: string): Promise<"file" | "directory" | "missing"> {
    const result = await this.#backend.exec(sandbox, {
      command: `p=${shQuote(path)}; if [ -d "$p" ]; then echo D; elif [ -e "$p" ]; then echo F; else echo N; fi`,
      timeoutMs: this.#defaultTimeoutMs,
    });
    if (result.exitCode !== 0) throw new Error(`stat(${path}) failed: ${result.stderr}`);
    const marker = result.stdout.trim();
    if (marker === "D") return "directory";
    if (marker === "F") return "file";
    return "missing";
  }

  async #list(sandbox: SandboxIdentity, path: string): Promise<string[]> {
    const dir = path === "" ? "." : path;
    const result = await this.#backend.exec(sandbox, {
      // `%f/%y` gives name/type; directories are suffixed with "/" like a real
      // listing, matching MemoryWorkspace.listDir's consumers.
      command: `cd ${shQuote(dir)} && find . -mindepth 1 -maxdepth 1 -printf '%f/%y\\n'`,
      timeoutMs: this.#defaultTimeoutMs,
    });
    if (result.exitCode !== 0) throw new Error(`list(${path}) failed: ${result.stderr}`);
    const names = result.stdout.split("\n").filter(Boolean).map((line) => {
      const slash = line.lastIndexOf("/");
      return slash >= 0 ? line.slice(0, slash) : line;
    });
    return names.sort();
  }

  /** Reject absolute paths and `..` escapes before they reach the pod. */
  #relative(path: string): string | undefined {
    if (escapesWorkspace(path)) return undefined;
    return normalizeRelative(path);
  }
}

/**
 * Durably checkpoint a sandboxed workspace: sync the pod back into its cache
 * workspace, then write the workspace diff to the blob store. Reuses the
 * existing diff/snapshot codec and the blob store — no second store.
 * Returns undefined when there is no live pod for the workspace.
 */
export async function checkpointSandboxWorkspace(
  executor: SandboxWorkspaceExecutor,
  workspaceId: WorkspaceId,
  blobStore: BlobStore,
): Promise<ArtifactRef | undefined> {
  if (!(await executor.checkpoint(workspaceId))) return undefined;
  const workspace = executor.workspace(workspaceId);
  if (!workspace) return undefined;
  const artifact = await workspace.exportArtifact(blobStore);
  return artifact.ref;
}

/**
 * Restore a checkpointed sandbox workspace into a fresh cache workspace, which
 * the next sandbox executor materializes into a new pod. The bytes come from
 * the blob store by digest, not from host RAM.
 */
export async function restoreSandboxWorkspace(
  blobStore: BlobStore,
  digest: string,
  workspace: MemoryWorkspace,
): Promise<void> {
  const bytes = await blobStore.get(digest);
  const { changes } = decodeWorkspaceDiff(bytes);
  for (const change of changes) {
    if (change.kind === "delete") workspace.delete(change.path);
    else if (change.content) workspace.write(change.path, change.content);
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
