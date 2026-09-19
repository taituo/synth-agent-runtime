import { AgentRuntime } from "../runtime/agent-runtime.js";
import type { AgentEngine } from "../runtime/agent-engine.js";
import { LocalMemoryDurability } from "../durability/local-memory.js";
import { LocalRuntimeStateStore } from "../durability/local-runtime-state.js";
import { DurableTurn } from "../runtime/durable-turn.js";
import { MemoryWorkspace } from "../workspace/memory-workspace.js";

/**
 * A small built-in crash scenario used by CI and examples. It leaves a turn
 * open, mutates the workspace, then constructs a fresh runtime and proves that
 * recovery restores the pre-turn snapshot.
 */
export async function runCrashRecoveryScenario(): Promise<{ before: string; dirty: string; recovered: string; rolledBack: number }> {
  const durability = new LocalMemoryDurability();
  const state = new LocalRuntimeStateStore();
  const runtime1 = new AgentRuntime(durability, undefined, new Map(), state);
  const workspace = await runtime1.createWorkspace(new MemoryWorkspace());
  workspace.write("state.txt", "before");
  const definition = { id: "worker", inferenceProfile: { id: "worker" } };
  const engine: AgentEngine = { async run() { return "ok"; } };
  await runtime1.spawn({ definition, engine, workspace });

  await DurableTurn.begin({ workspace, store: state, attemptId: "provider-a" });
  workspace.write("state.txt", "dirty-after-crash");
  const dirty = (await workspace.readText("state.txt")) ?? "<missing>";

  const runtime2 = new AgentRuntime(durability, undefined, new Map([[workspace.id, workspace]]), state);
  const result = await runtime2.recover({ definition: () => definition, engine: () => engine });
  const recovered = (await workspace.readText("state.txt")) ?? "<missing>";
  return { before: "before", dirty, recovered, rolledBack: result.incompleteTurnsRolledBack };
}
