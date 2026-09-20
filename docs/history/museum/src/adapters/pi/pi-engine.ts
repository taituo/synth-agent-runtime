import type { AgentMessage } from "../../core/types.js";
import type { AgentEngine, AgentEngineContext } from "../../runtime/agent-engine.js";

/**
 * Structural adapter so runtime-core does not depend on Pi packages.
 * A real Pi AgentSession satisfies this shape with a tiny wrapper.
 */
export interface PiSessionLike {
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp"; source?: string }): Promise<void>;
  subscribe?(listener: (event: unknown) => void): () => void;
  isStreaming?: boolean;
}

export class PiAgentEngine implements AgentEngine {
  #session?: PiSessionLike;
  constructor(private readonly createSession: (context: AgentEngineContext) => Promise<PiSessionLike>) {}

  async run(messages: readonly AgentMessage[], context: AgentEngineContext): Promise<unknown> {
    const session = await this.createSession(context);
    this.#session = session;
    const unsubscribe = session.subscribe?.((event) => context.emitOutput(JSON.stringify(event)));
    try {
      const input = [...messages].reverse().find((m) => m.role === "human")?.text ?? "Continue the assigned task.";
      await session.prompt(input, { source: "runtime" });
      return { ok: true };
    } finally {
      unsubscribe?.();
      this.#session = undefined;
    }
  }

  async steer(message: AgentMessage): Promise<void> {
    if (!this.#session) return;
    await this.#session.prompt(message.text, { streamingBehavior: "steer", source: "runtime" });
  }
}
