import type { GymTurn, GymTurnInput, GymTurnResult } from "./attempt.js";
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
export interface GatewayGymTurnOptions {
    /** Base URL of the gateway, no trailing slash (e.g. http://127.0.0.1:8787). */
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** Extra headers (e.g. tenancy/lane hints for the gateway). */
    headers?: Record<string, string>;
}
/**
 * The plain arm: a direct call to an OpenAI-compatible gateway. No Temporal, no
 * retry, no receipts. The prompt is the shared gym prompt, so this arm and the
 * durable arm differ only in durability.
 */
export declare function createGatewayGymTurn(options: GatewayGymTurnOptions): GymTurn;
