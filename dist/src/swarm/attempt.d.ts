/**
 * One shared loop for both arms of the signal swarm.
 *
 * Both the plain arm and the durable arm call THIS function; the only injected
 * difference is which `EffectRunner` and which `SwarmTurn` they pass. The loop
 * ends by scoring the reported findings against the PLANTED ground truth, so the
 * two-arm comparison and the fault matrix work exactly as they do for the gym:
 * durability either preserves partial findings across a SIGKILL or it does not.
 *
 * The terminal step differs from the gym's loop by necessity: there is no patch
 * and no held-out test, only findings compared to what was planted.
 */
import type { EffectRunner } from "../gym/tools.js";
import type { SwarmCheckpointStore, SwarmTranscriptEntry } from "./checkpoint.js";
import { type FindingScore, type ReportedFinding } from "./findings.js";
import { type SignalStream } from "./stream.js";
import { type SwarmToolCall, type SwarmToolDefinition } from "./tools.js";
export interface SwarmTurnInput {
    turnIndex: number;
    streamName: string;
    systemPrompt: string;
    userPrompt: string;
    transcript: readonly SwarmTranscriptEntry[];
    tools: readonly SwarmToolDefinition[];
    findings: readonly ReportedFinding[];
}
export interface SwarmTurnResult {
    toolCalls: SwarmToolCall[];
    content?: string;
    requestedModel?: string;
    servedModel?: string | null;
    modelSubstituted?: boolean;
    latencyMs?: number;
    usage?: unknown;
}
/** Injected model boundary: a direct gateway call, a Temporal activity, or a script. */
export type SwarmTurn = (input: SwarmTurnInput) => Promise<SwarmTurnResult>;
export interface RunSwarmAttemptOptions {
    stream?: SignalStream;
    runner: EffectRunner;
    turn: SwarmTurn;
    checkpoint?: SwarmCheckpointStore;
    checkpointKey?: string;
    /** Hard cap on model turns. Default 8. */
    maxTurns?: number;
    /** Wall-clock budget. Default 5 minutes. */
    deadlineMs?: number;
    now?: () => number;
    onTool?: (result: {
        turnIndex: number;
        call: SwarmToolCall;
        ok: boolean;
        observation: string;
    }) => void;
}
export interface SwarmAttemptRecord {
    findings: ReportedFinding[];
    score: FindingScore;
    turns: number;
    transcript: SwarmTranscriptEntry[];
    requestedModel?: string | null;
    servedModel?: string | null;
    modelSubstituted: boolean;
    finished: boolean;
}
export declare function runSwarmAttempt(options: RunSwarmAttemptOptions): Promise<SwarmAttemptRecord>;
