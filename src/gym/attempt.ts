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
import { isTampering, patchTargetPaths, scoreGymPatch, PROTECTED_PATTERNS } from "./scoring.js";
import { buildGymSystemPrompt, buildGymUserPrompt, createGymTools, GYM_TOOL_DEFINITIONS, type EffectRunner, type GymToolCall, type GymToolDefinition } from "./tools.js";
import { harvestPatch } from "./harvest.js";
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
  onTool?: (result: { turnIndex: number; call: GymToolCall; ok: boolean; observation: string }) => void;
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

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_DEADLINE_MS = 10 * 60_000;

/**
 * Run one attempt to completion and return the record the milestone reports on.
 * Never throws for an agent failure: every path returns a record, because
 * `errored`/`timed-out` are outcomes, not crashes.
 */
export async function runGymAttempt(options: RunGymAttemptOptions): Promise<GymAttemptRecord> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const { task, runner } = options;

  const visibleTestPath = task.task.visibleTestPath;
  const systemPrompt = buildGymSystemPrompt(visibleTestPath);
  let visibleTestContent = "";
  try {
    visibleTestContent = await runner.read(visibleTestPath);
  } catch {
    // A missing visible test is not fatal to the loop; the scorer still decides.
  }
  const userPrompt = buildGymUserPrompt({ visibleTestPath, visibleTestContent });
  const tools = createGymTools(runner, {
    visibleTestPath,
    ...(options.protectedPatterns ? { protectedPatterns: options.protectedPatterns } : {}),
    ...(options.nodeBin ? { nodeBin: options.nodeBin } : {}),
    ...(options.execTimeoutMs ? { execTimeoutMs: options.execTimeoutMs } : {}),
  });

  const transcript: GymTranscriptEntry[] = [];
  let callCount = 0;
  let turns = 0;
  let finished = false;
  let timedOut = false;
  let errored: string | undefined;
  let requestedModel: string | null = null;
  let servedModel: string | null = null;
  let modelSubstituted = false;

  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
    if (now() - startedAt > deadlineMs) {
      timedOut = true;
      break;
    }
    let result: GymTurnResult;
    callCount++;
    try {
      result = await options.turn({ turnIndex, repoDir: task.repoDir, visibleTestPath, systemPrompt, userPrompt, transcript: [...transcript], tools: GYM_TOOL_DEFINITIONS });
    } catch (error) {
      errored = error instanceof Error ? error.message : String(error);
      break;
    }
    turns++;
    if (result.requestedModel) requestedModel = result.requestedModel;
    if (result.servedModel !== undefined) servedModel = result.servedModel;
    if (result.modelSubstituted) modelSubstituted = true;

    const assistantContent = result.content ?? JSON.stringify({ tool_calls: result.toolCalls });
    transcript.push({ role: "assistant", content: assistantContent });

    for (const call of result.toolCalls) {
      if (call.name === "finish") {
        finished = true;
        break;
      }
      const toolResult = await tools.execute(call);
      transcript.push({ role: "tool", name: call.name, content: toolResult.observation });
      options.onTool?.({ turnIndex, call, ok: toolResult.ok, observation: toolResult.observation });
    }
    if (finished) break;
    if (now() - startedAt > deadlineMs) {
      timedOut = true;
      break;
    }
  }

  let patch = "";
  let score: GymScore;
  let protectedPathsTouched: string[] = [];
  if (errored !== undefined) {
    score = { outcome: "errored", touchedPaths: [], detail: errored };
  } else {
    try {
      patch = await harvestPatch(runner, { repoDir: task.repoDir, baseRef: "HEAD" });
      protectedPathsTouched = await patchTargetPaths(patch).then((paths) =>
        paths.filter((path) => path === visibleTestPath || isTampering([path]) || PROTECTED_PATTERNS.some((pattern) => pattern.test(path))),
      );
      if (patch.trim().length === 0) {
        // No changes means the planted bug is still present. Score it as `failed`
        // here rather than handing an empty patch to a scorer that may treat it
        // as malformed; this is a runner-level fact, not a scorer decision.
        score = { outcome: "failed", touchedPaths: [], detail: "no changes; the planted bug is still present" };
      } else {
        const scorer = options.score ?? scoreGymPatch;
        score = await scorer({
          patchText: patch,
          baseRepoDir: task.baseRepoDir,
          hiddenTestPath: task.hiddenTestPath,
          ...(options.nodeBin ? { nodeBin: options.nodeBin } : {}),
        });
      }
    } catch (error) {
      score = { outcome: "errored", touchedPaths: [], detail: error instanceof Error ? error.message : String(error) };
      errored = score.detail;
    }
  }

  let outcome: GymOutcome = score.outcome;
  if (errored !== undefined) outcome = "errored";
  else if (timedOut) outcome = "timed-out";

  return {
    outcome,
    requestedModel,
    servedModel,
    modelSubstituted,
    wallTimeMs: now() - startedAt,
    callCount,
    turns,
    protectedPathsTouched,
    patch,
    score,
    ...(errored !== undefined ? { error: errored } : {}),
  };
}
