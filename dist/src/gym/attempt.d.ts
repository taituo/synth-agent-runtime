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
import type { GymCheckpointStore } from "./checkpoint.js";
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
    /** HTTP attempts the turn made (1 unless the turn retried transient failures). */
    attempts?: number;
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
    /**
     * Durable work-product checkpoints. When set with `checkpointKey`, the loop
     * saves a patch+transcript checkpoint after every turn and, if a checkpoint
     * already exists for the key, restores it and resumes from there instead of
     * re-running from the pinned base. This is what makes a retried activity
     * continue the agent's work rather than re-materialize the bugged checkout.
     */
    checkpoint?: GymCheckpointStore;
    checkpointKey?: string;
    /**
     * How many times a malformed (non-JSON / bad tool-call protocol) reply may be
     * re-asked within one attempt. Default 1: enough for a stochastic slip, not
     * enough for a model that reliably emits bad JSON to burn the budget.
     */
    maxReasks?: number;
    /** Wall-clock budget for the whole attempt. Default 10 minutes. */
    deadlineMs?: number;
    nodeBin?: string;
    /**
     * Node binary the `run_visible_test` tool invokes. Defaults to `nodeBin`.
     * The sandbox runner must set this to the Pod's own `node` (on PATH), because
     * a host node path does not exist inside the Pod (exit 127).
     */
    visibleTestNodeBin?: string;
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
/**
 * A turn failure, kept structured so a durable supervisor can decide what to do.
 *
 * `transient` — provider/network/rate-limit failure; the durable arm retries and
 * parks (with `retryAfterMs` when the server supplied a hint).
 * `malformed` — the reply was not valid JSON/tool-call protocol. The runner
 * re-asks ONCE (see `maxReasks`) because the failure is stochastic; if the
 * re-ask is also malformed it is `fatal` for the attempt. It is deliberately NOT
 * `transient`, so a model that reliably emits bad JSON cannot consume the whole
 * durable retry budget on every turn.
 * `fatal` — anything else; no recovery.
 */
export interface GymFailure {
    message: string;
    /** True when retrying the attempt could plausibly succeed (5xx, 429, timeout). */
    transient: boolean;
    kind: "transient" | "malformed" | "fatal";
    /** Server reset hint in ms, when the provider supplied one. */
    retryAfterMs?: number;
}
export interface GymAttemptRecord {
    outcome: GymOutcome;
    requestedModel: string | null;
    servedModel: string | null;
    modelSubstituted: boolean;
    wallTimeMs: number;
    /** Number of model turn invocations (including ones that threw). */
    callCount: number;
    /**
     * HTTP attempts summed across turns. Equals `callCount` when no turn retried;
     * higher when a turn absorbed transient failures in-turn. Reported separately
     * so a fair-retry plain arm is not confused with one that made more model turns.
     */
    httpAttempts: number;
    /** Turns that returned normally. */
    turns: number;
    /** Malformed-reply re-asks consumed (bounded by `maxReasks`). */
    reasks: number;
    /** When resuming, the turn index the attempt continued from. */
    resumedFromTurn?: number;
    protectedPathsTouched: string[];
    patch: string;
    score: GymScore;
    error?: string;
    /** Present when a model turn threw; the durable arm turns this into a retry. */
    failure?: GymFailure;
}
/**
 * Run one attempt to completion and return the record the milestone reports on.
 * Never throws for an agent failure: every path returns a record, because
 * `errored`/`timed-out` are outcomes, not crashes.
 */
export declare function runGymAttempt(options: RunGymAttemptOptions): Promise<GymAttemptRecord>;
