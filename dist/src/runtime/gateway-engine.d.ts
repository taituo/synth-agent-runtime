import type { AgentMessage } from "../core/types.js";
import type { Effect } from "../execution/types.js";
import type { AgentEngine, AgentEngineContext } from "./agent-engine.js";
/**
 * The shared turn body for a gateway-backed agent.
 *
 * One turn is: send the turn's messages to an OpenAI-compatible gateway, then
 * execute the tool calls the model asked for through the execution rung
 * (`AgentEngineContext.executeEffect`), and return the outcome. The durable
 * `runTurn` activity and any direct caller share this engine; neither is
 * allowed to hand-roll the model HTTP call.
 */
export interface GatewayToolCall {
    name: string;
    arguments: Record<string, unknown>;
}
export interface GatewayToolObservation {
    name: string;
    ok: boolean;
    output?: unknown;
    error?: string;
}
export interface GatewayUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}
export interface GatewayTurnOutcome {
    /** The assistant's raw content, the input to any consumer-specific parsing. */
    content: string;
    toolCalls: GatewayToolCall[];
    observations: GatewayToolObservation[];
    requestedModel: string;
    /** The model the upstream said answered, or null when it did not say. */
    servedModel: string | null;
    /** True only when the upstream named a model different from the requested one. */
    modelSubstituted: boolean;
    latencyMs: number;
    usage?: GatewayUsage;
}
/** A non-2xx gateway reply, carrying the status for retry-policy decisions. */
export declare class GatewayHttpError extends Error {
    readonly status: number;
    readonly retryAfterMs?: number;
    constructor(message: string, status: number, retryAfterMs?: number);
}
export interface GatewayAgentEngineOptions {
    /** Base URL of the gateway, without a trailing path (e.g. http://127.0.0.1:8787). */
    baseUrl: string;
    model: string;
    apiKey?: string;
    /** Per-request timeout. Reasoning models can take tens of seconds. Default 120s. */
    timeoutMs?: number;
    /** How often to heartbeat while waiting on the model. Default 10s. */
    heartbeatIntervalMs?: number;
    fetchImpl?: typeof fetch;
    /** Milestone hook (e.g. a Temporal activity heartbeat). */
    heartbeat?: () => void;
    /** The system prompt for this agent. */
    systemPrompt: string;
    /** Render the turn's messages into the single user message sent to the model. */
    buildUserMessage(messages: readonly AgentMessage[]): string;
    /**
     * Parse the assistant content into tool calls. The default reads the
     * `tool_calls` array from a JSON reply and tolerates a code fence/prose.
     * A consumer with no tools (e.g. event triage) gets an empty list.
     */
    parseToolCalls?: (content: string) => GatewayToolCall[];
    /**
     * Map one model tool call to an execution-rung `Effect`. Returning undefined
     * leaves the call unexecuted (recorded as a refused observation).
     */
    toEffect?: (call: GatewayToolCall, context: AgentEngineContext, index: number) => Effect | undefined;
    /** Called once per successful turn, with the turn's outcome. */
    onTurn?: (outcome: GatewayTurnOutcome, context: AgentEngineContext) => void;
}
/** Default tool-call parser: a JSON reply carrying an optional `tool_calls` array. */
export declare function parseToolCallsFromContent(content: string): GatewayToolCall[];
export declare class GatewayAgentEngine implements AgentEngine {
    #private;
    constructor(options: GatewayAgentEngineOptions);
    run(messages: readonly AgentMessage[], context: AgentEngineContext): Promise<GatewayTurnOutcome>;
}
export declare function createGatewayAgentEngine(options: GatewayAgentEngineOptions): GatewayAgentEngine;
