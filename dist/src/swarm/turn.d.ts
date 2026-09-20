/**
 * The swarm's model boundary: a gateway turn that returns swarm tool calls.
 *
 * Mirrors `createGatewayGymTurn` (same OpenAI-compatible request, same
 * requested/served model accounting) but parses calls against the swarm tool
 * surface. The swarm and the gym share the loop and the runner; only the tool
 * names and the terminal step differ.
 */
import type { SwarmTurn } from "./attempt.js";
import type { SwarmToolCall } from "./tools.js";
export interface GatewaySwarmTurnOptions {
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
    maxTokens?: number;
    fetchImpl?: typeof fetch;
    headers?: Record<string, string>;
}
/**
 * Turn raw model `tool_calls` into swarm calls. Unknown names pass through so the
 * loop can report them as the model's mistake rather than silently dropping them.
 */
export declare function coerceSwarmToolCalls(raw: Array<{
    name?: unknown;
    arguments?: unknown;
}>): SwarmToolCall[];
/**
 * Recover tool calls a model wrote as text (some models answer in content with a
 * JSON blob or a fenced block instead of a structured tool_calls array).
 */
export declare function extractSwarmToolCalls(content: string): SwarmToolCall[];
export declare function createGatewaySwarmTurn(options: GatewaySwarmTurnOptions): SwarmTurn;
/** The tool names the swarm exposes; exported for the driver's prompt/description checks. */
export declare function isSwarmToolName(name: string): boolean;
