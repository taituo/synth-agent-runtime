import type { AgentMessage } from "../../core/types.js";
import type { AgentEngine, AgentEngineContext } from "../../runtime/agent-engine.js";
/**
 * Structural adapter so runtime-core does not depend on Pi packages.
 * A real Pi AgentSession satisfies this shape with a tiny wrapper.
 */
export interface PiSessionLike {
    prompt(text: string, options?: {
        streamingBehavior?: "steer" | "followUp";
        source?: string;
    }): Promise<void>;
    subscribe?(listener: (event: unknown) => void): () => void;
    isStreaming?: boolean;
}
export declare class PiAgentEngine implements AgentEngine {
    #private;
    private readonly createSession;
    constructor(createSession: (context: AgentEngineContext) => Promise<PiSessionLike>);
    run(messages: readonly AgentMessage[], context: AgentEngineContext): Promise<unknown>;
    steer(message: AgentMessage): Promise<void>;
}
