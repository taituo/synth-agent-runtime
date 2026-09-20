/**
 * The swarm agent's tool surface, over the SAME `EffectRunner` the gym uses, so
 * the identical tools run over a local temp dir or a sandboxed workspace and
 * both arms send the same prompt and tools.
 *
 * The stream and the findings are files in the workspace: `events.jsonl` (read
 * only) and `findings.jsonl` (append-only). A finding is data; nothing is
 * executed.
 */
import type { EffectRunner } from "../gym/tools.js";
import { type ReportedFinding } from "./findings.js";
import { type SignalStream } from "./stream.js";
export type SwarmToolName = "list_events" | "read_event" | "report_finding" | "finish";
export interface SwarmToolCall {
    name: SwarmToolName;
    arguments: Record<string, unknown>;
}
export interface SwarmToolDefinition {
    name: SwarmToolName;
    description: string;
    parameters: Record<string, unknown>;
}
export interface SwarmToolResult {
    ok: boolean;
    observation: string;
}
export interface SwarmToolOptions {
    stream: SignalStream;
    eventsPath?: string;
    findingsPath?: string;
}
export interface SwarmTools {
    readonly definitions: readonly SwarmToolDefinition[];
    execute(call: SwarmToolCall): Promise<SwarmToolResult>;
    readFindings(): Promise<ReportedFinding[]>;
    finished(): boolean;
}
export declare const EVENTS_FILE = "events.jsonl";
export declare const FINDINGS_FILE = "findings.jsonl";
export declare const SWARM_TOOL_DEFINITIONS: readonly SwarmToolDefinition[];
/** Write the stream into the workspace once, so the tools read it like any file. */
export declare function materializeStream(runner: EffectRunner, stream: SignalStream, eventsPath?: string): Promise<void>;
export declare function createSwarmTools(runner: EffectRunner, options: SwarmToolOptions): SwarmTools;
export declare function buildSwarmSystemPrompt(tools?: readonly SwarmToolDefinition[]): string;
export declare function buildSwarmUserPrompt(stream: SignalStream): string;
