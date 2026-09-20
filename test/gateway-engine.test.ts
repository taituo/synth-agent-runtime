import test from "node:test";
import assert from "node:assert/strict";
import type { AgentId, WorkspaceId } from "../src/core/ids.js";
import type { AgentEngineContext } from "../src/runtime/agent-engine.js";
import { createGatewayAgentEngine } from "../src/runtime/gateway-engine.js";
import { ExecutionBroker } from "../src/execution/broker.js";
import { SyntheticExecutor } from "../src/execution/synthetic.js";
import type { Effect, EffectContext, EffectResult, Executor } from "../src/execution/types.js";
import { MemoryWorkspace } from "../src/workspace/memory-workspace.js";

/** A counting wrapper that delegates to the real synthetic rung. */
class CountingExecutor implements Executor {
  readonly id = "counting-synthetic";
  readonly fidelity = 0;
  count = 0;
  readonly #inner: SyntheticExecutor;

  constructor(workspaces: Map<WorkspaceId, MemoryWorkspace>) {
    this.#inner = new SyntheticExecutor(workspaces);
  }

  canExecute(effect: Effect, _context: EffectContext): boolean | Promise<boolean> {
    return this.#inner.canExecute(effect);
  }

  async execute(effect: Effect, context: EffectContext): Promise<EffectResult> {
    this.count++;
    return this.#inner.execute(effect, context);
  }
}

test("the gateway engine executes the model's tool calls through the execution rung", async () => {
  const workspace = new MemoryWorkspace();
  workspace.write("a.txt", "hello from the rung");
  const workspaces = new Map<WorkspaceId, MemoryWorkspace>([[workspace.id, workspace]]);
  const executor = new CountingExecutor(workspaces);
  const broker = new ExecutionBroker([executor]);

  const engine = createGatewayAgentEngine({
    baseUrl: "http://gw.test",
    model: "m",
    systemPrompt: "system",
    buildUserMessage: (messages) => messages.map((message) => message.text).join("\n"),
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          model: "m",
          choices: [{ message: { role: "assistant", content: JSON.stringify({ tool_calls: [{ name: "read_file", arguments: { path: "a.txt" } }] }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
    toEffect: (call) => (call.name === "read_file" ? { id: "fx_read", kind: "workspace.read", path: String(call.arguments.path ?? "") } : undefined),
  });

  const agentId = "agt_engine" as AgentId;
  const context: AgentEngineContext = {
    agentId,
    workspaceId: workspace.id,
    definition: { id: "def", inferenceProfile: { id: "m" } },
    inferenceProfile: { id: "m", model: "m" },
    signal: new AbortController().signal,
    emitOutput: () => {},
    emitTool: () => {},
    executeEffect: (effect, minFidelity) => broker.execute(effect, { agentId, workspaceId: workspace.id }, minFidelity),
  };

  const outcome = await engine.run([{ id: "m1", role: "human", text: "read a.txt", createdAt: 1 }], context);

  assert.equal(executor.count, 1, "the engine must dispatch exactly one effect through the rung");
  const observation = outcome.observations[0]!;
  assert.equal(observation.name, "read_file");
  assert.equal(observation.ok, true);
  assert.equal(new TextDecoder().decode(observation.output as Uint8Array), "hello from the rung");
});
