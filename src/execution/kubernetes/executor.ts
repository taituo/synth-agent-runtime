import type { WorkspaceId } from "../../core/ids.js";
import { MemoryWorkspace } from "../../workspace/memory-workspace.js";
import type { Effect, EffectContext, EffectResult, Executor } from "../types.js";
import type { KubernetesResourceClass } from "../resource-class.js";
import { WarmSandboxPool } from "./pool.js";
import type { SandboxBackend, WarmSandboxLease } from "./types.js";
import { WorkspaceSynchronizer } from "./workspace-sync.js";

export interface KubernetesExecutorOptions {
  resourceClass: KubernetesResourceClass;
  backend: SandboxBackend;
  workspaces: Map<WorkspaceId, MemoryWorkspace>;
  pool?: WarmSandboxPool;
  synchronizer?: WorkspaceSynchronizer;
}

/** Physical executor for commands that the synthetic environment cannot run. */
export class KubernetesExecutor implements Executor {
  readonly id: string;
  readonly fidelity: number;
  readonly resourceClassId: string;
  readonly #resourceClass: KubernetesResourceClass;
  readonly #backend: SandboxBackend;
  readonly #workspaces: Map<WorkspaceId, MemoryWorkspace>;
  readonly #pool?: WarmSandboxPool;
  readonly #sync: WorkspaceSynchronizer;

  constructor(options: KubernetesExecutorOptions) {
    this.#resourceClass = options.resourceClass;
    this.#backend = options.backend;
    this.#workspaces = options.workspaces;
    this.#pool = options.pool;
    this.#sync = options.synchronizer ?? new WorkspaceSynchronizer(options.backend);
    this.id = `kubernetes:${options.resourceClass.id}`;
    this.resourceClassId = options.resourceClass.id;
    this.fidelity = options.resourceClass.fidelity;
  }

  canExecute(effect: Effect, context: EffectContext): boolean {
    if (effect.kind !== "process.exec") return false;
    if (effect.resourceClass && effect.resourceClass !== this.resourceClassId) return false;
    const allowed = context.executionPolicy?.allowedClasses;
    if (allowed && !allowed.includes(this.resourceClassId)) return false;
    return true;
  }

  async execute(effect: Effect, context: EffectContext): Promise<EffectResult> {
    if (effect.kind !== "process.exec") return { ok: false, error: "ESCALATION_REQUIRED" };
    const workspace = this.#workspaces.get(context.workspaceId);
    if (!workspace) return { ok: false, error: `Unknown workspace ${context.workspaceId}` };

    let lease: WarmSandboxLease | undefined;
    let oneShot = false;
    try {
      if (this.#pool && this.#resourceClass.warmPool) {
        lease = await this.#pool.acquire(this.resourceClassId);
      } else {
        const sandbox = await this.#backend.create(this.#resourceClass, {
          labels: { "synth.openai.dev/agent-id": String(context.agentId) },
        });
        oneShot = true;
        lease = {
          sandbox,
          resourceClass: this.#resourceClass,
          release: async () => this.#backend.destroy(sandbox),
        };
      }

      await this.#sync.materialize(workspace, lease.sandbox);
      const result = await this.#backend.exec(lease.sandbox, {
        command: effect.command,
        cwd: effect.cwd,
        env: effect.env,
        timeoutMs: effect.timeoutMs,
      });
      await this.#sync.syncBack(workspace, lease.sandbox);
      return {
        ok: result.exitCode === 0,
        output: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut ?? false,
          sandboxId: lease.sandbox.id,
          resourceClass: this.resourceClassId,
        },
        ...(result.exitCode === 0 ? {} : { error: result.timedOut ? "EXECUTION_TIMEOUT" : `Command exited ${result.exitCode}` }),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (lease) await lease.release({ destroy: oneShot }).catch(() => {});
    }
  }
}
