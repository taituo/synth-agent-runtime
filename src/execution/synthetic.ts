import type { WorkspaceId } from "../core/ids.js";
import { MemoryWorkspace } from "../workspace/memory-workspace.js";
import type { Effect, EffectContext, EffectResult, Executor } from "./types.js";

/** Lowest-fidelity executor: deterministic workspace operations only. */
export class SyntheticExecutor implements Executor {
  readonly id = "synthetic";
  readonly fidelity = 0;
  readonly #workspaces: Map<WorkspaceId, MemoryWorkspace>;

  constructor(workspaces: Map<WorkspaceId, MemoryWorkspace>) {
    this.#workspaces = workspaces;
  }

  canExecute(effect: Effect): boolean {
    return effect.kind.startsWith("workspace.") || effect.kind === "process.exec";
  }

  async execute(effect: Effect, context: EffectContext): Promise<EffectResult> {
    const workspace = this.#workspaces.get(context.workspaceId);
    if (!workspace) return { ok: false, error: `Unknown workspace ${context.workspaceId}` };
    switch (effect.kind) {
      case "workspace.read":
        return { ok: true, output: await workspace.read(effect.path) };
      case "workspace.write":
        workspace.write(effect.path, effect.content);
        return { ok: true };
      case "workspace.delete":
        workspace.delete(effect.path);
        return { ok: true };
      case "workspace.list":
        return { ok: true, output: await workspace.listDir(effect.path) };
      case "process.exec":
        return { ok: false, error: "ESCALATION_REQUIRED" };
      default:
        return { ok: false, error: "ESCALATION_REQUIRED" };
    }
  }
}
