/**
 * One shared loop for both arms.
 *
 * Both the plain arm and the durable arm call THIS function; the only injected
 * difference is which `EffectRunner` and which `GymTurn` they pass. If the arms
 * had separate loops, the comparison would measure the loops rather than
 * durability and the milestone would be void.
 *
 * The loop materializes nothing itself: it receives a materialized task whose
 * `baseRepoDir` is the BUGGED committed checkout, runs turns against the agent's
 * tools, harvests the patch from git, and scores it against the held-out test.
 */
import type { GymOutcome, GymScore } from "./scoring.js";
import { type EffectRunner, type GymToolCall, type GymToolDefinition } from "./tools.js";
import type { MaterializedGymTask } from "./task.js";
export interface GymTranscriptEntry {
    role: "assistant" | "tool";
    name?: string;
    content: string;
}
export interface GymTurnInput {
    turnIndex: number;
    repoDir: string;
    visibleTestPath: string;
    systemPrompt: string;
    userPrompt: string;
    transcript: readonly GymTranscriptEntry[];
    tools: readonly GymToolDefinition[];
}
export interface GymTurnResult {
    toolCalls: GymToolCall[];
    content?: string;
    /** Model id the runtime asked for. */
    requestedModel?: string;
    /** Model id upstream said answered, or null when it did not say. */
    servedModel?: string | null;
    modelSubstituted?: boolean;
    latencyMs?: number;
    usage?: unknown;
}
/** Injected model boundary: a direct gateway call, a Temporal activity, or a script. */
export type GymTurn = (input: GymTurnInput) => Promise<GymTurnResult>;
/**
 * The single scoring seam. The default is `scoreGymPatch`, but the milestone
 * re-points it at the hardened scorer without touching this loop. A thrown
 * scorer (e.g. a patch that turns the hidden-test destination into a directory)
 * is an `errored` outcome, never a crash.
 */
export interface GymScoreRequest {
    patchText: string;
    baseRepoDir: string;
    hiddenTestPath: string;
    nodeBin?: string;
}
export type GymScorer = (request: GymScoreRequest) => Promise<GymScore>;
export interface RunGymAttemptOptions {
    task: MaterializedGymTask;
    runner: EffectRunner;
    turn: GymTurn;
    /** Overridable scorer seam (defaults to `scoreGymPatch`). */
    score?: GymScorer;
    /** Hard cap on model turns. Default 8. */
    maxTurns?: number;
    /** Wall-clock budget for the whole attempt. Default 10 minutes. */
    deadlineMs?: number;
    nodeBin?: string;
    execTimeoutMs?: number;
    /** Extra protected path patterns beyond the scorer's defaults. */
    protectedPatterns?: readonly RegExp[];
    now?: () => number;
    /** Called after every executed tool call, for observers/drivers. */
    onTool?: (result: {
        turnIndex: number;
        call: GymToolCall;
        ok: boolean;
        observation: string;
    }) => void;
}
export interface GymAttemptRecord {
    outcome: GymOutcome;
    requestedModel: string | null;
    servedModel: string | null;
    modelSubstituted: boolean;
    wallTimeMs: number;
    /** Number of model turn invocations (including ones that threw). */
    callCount: number;
    /** Turns that returned normally. */
    turns: number;
    protectedPathsTouched: string[];
    patch: string;
    score: GymScore;
    error?: string;
}
/**
 * Run one attempt to completion and return the record the milestone reports on.
 * Never throws for an agent failure: every path returns a record, because
 * `errored`/`timed-out` are outcomes, not crashes.
 */
export declare function runGymAttempt(options: RunGymAttemptOptions): Promise<GymAttemptRecord>;
