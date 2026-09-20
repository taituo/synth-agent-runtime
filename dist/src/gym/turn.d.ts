import type { GymToolCall } from "./tools.js";
import type { GymTurn, GymTurnInput, GymTurnResult } from "./attempt.js";
/** The gym's tool-call protocol: a JSON reply carrying `tool_calls`. */
export declare function parseGymToolCalls(content: string): GymToolCall[];
export interface ScriptedTurnDefaults {
    requestedModel?: string;
    servedModel?: string | null;
    modelSubstituted?: boolean;
    latencyMs?: number;
}
export type ScriptedStep = GymTurnResult | ((input: GymTurnInput) => GymTurnResult | Promise<GymTurnResult>);
/**
 * A deterministic fake model. Steps are consumed by turn index; once the script
 * is exhausted the turn calls `finish`, so a dry run always terminates.
 */
export declare function createScriptedGymTurn(steps: readonly ScriptedStep[], defaults?: ScriptedTurnDefaults): GymTurn;
/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined for absent/invalid values so a broken upstream cannot park
 * an attempt for an absurd time.
 */
export declare function parseRetryAfterMs(headers: Headers): number | undefined;
export interface GatewayGymTurnOptions {
    /** Base URL of the gateway, no trailing slash (e.g. http://127.0.0.1:8787). */
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
    /** Upper bound on generated tokens, so a runaway answer cannot stall a turn. */
    maxTokens?: number;
    fetchImpl?: typeof fetch;
    /** Extra headers (e.g. tenancy/lane hints for the gateway). */
    headers?: Record<string, string>;
    /**
     * Bounded transient retry. Omit (or `maxAttempts: 1`) for the historical
     * single-shot plain arm. Both arms of a comparison must pass the same value.
     */
    retry?: GatewayRetryOptions;
}
export interface GatewayRetryOptions {
    /** Total attempts including the first. 1 disables retry. Default 1. */
    maxAttempts?: number;
    /** First backoff delay in ms; doubles each attempt. Default 250. */
    baseDelayMs?: number;
    /** Ceiling for any single backoff, including a server `Retry-After`. Default 5000. */
    maxDelayMs?: number;
    /** Injectable sleep, for tests. */
    sleepImpl?: (ms: number) => Promise<void>;
}
/**
 * The fair-control retry config. Both arms pass this so the comparison isolates
 * durability rather than the presence of retry. Three attempts with exponential
 * backoff is what a normal HTTP client ships.
 */
export declare const DEFAULT_GATEWAY_RETRY: Required<Pick<GatewayRetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs">>;
/**
 * The plain arm: a direct call to an OpenAI-compatible gateway, made by the
 * runtime's shared turn body. This function only configures `GatewayAgentEngine`
 * (system prompt, tool-call parser, model/endpoint) and maps its outcome back to
 * the gym's turn shape; it does NOT build an HTTP request. With `retry` omitted
 * it is a single shot; with the shared `DEFAULT_GATEWAY_RETRY` it does the
 * bounded transient retry a normal HTTP client does, so it is a fair control
 * against the durable arm. The prompt is the shared gym prompt either way.
 */
export declare function createGatewayGymTurn(options: GatewayGymTurnOptions): GymTurn;
