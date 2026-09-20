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
import { isTampering, isolatedScoreGymPatch, patchTargetPaths, PROTECTED_PATTERNS } from "./scoring.js";
import { buildGymSystemPrompt, buildGymUserPrompt, createGymTools, GYM_TOOL_DEFINITIONS, type EffectRunner, type GymToolCall, type GymToolDefinition } from "./tools.js";
import { harvestPatch } from "./harvest.js";
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
  execTimeoutMs?: number;
  /** Extra protected path patterns beyond the scorer's defaults. */
  protectedPatterns?: readonly RegExp[];
  now?: () => number;
  /** Called after every executed tool call, for observers/drivers. */
  onTool?: (result: { turnIndex: number; call: GymToolCall; ok: boolean; observation: string }) => void;
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
  const maxReasks = options.maxReasks ?? 1;
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
  let httpAttempts = 0;
  let turns = 0;
  let finished = false;
  let timedOut = false;
  let errored: string | undefined;
  let failure: GymFailure | undefined;
  let reasks = 0;
  let requestedModel: string | null = null;
  let servedModel: string | null = null;
  let modelSubstituted = false;
  let startTurnIndex = 0;
  let resumedFromTurn: number | undefined;
  let lastCheckpointDigest: string | undefined;

  if (options.checkpoint && options.checkpointKey) {
    const saved = await options.checkpoint.load(options.checkpointKey);
    if (saved) {
      if (saved.patchText.trim().length > 0) {
        const patchPath = ".gym-checkpoint.patch";
        await runner.write(patchPath, saved.patchText);
        const applied = await runner.exec(`git apply ${patchPath}`, { cwd: task.repoDir });
        await runner.exec(`rm -f ${patchPath}`, { cwd: task.repoDir });
        if (applied.code !== 0) throw new Error(`failed to restore checkpoint patch: ${applied.stderr || applied.stdout}`);
      }
      transcript.push(...saved.transcript);
      startTurnIndex = saved.turnIndex;
      resumedFromTurn = saved.turnIndex;
      lastCheckpointDigest = saved.digest;
      if (saved.requestedModel) requestedModel = saved.requestedModel;
      if (saved.servedModel !== undefined) servedModel = saved.servedModel;
    }
  }

  for (let turnIndex = startTurnIndex; turnIndex < maxTurns; turnIndex++) {
    if (now() - startedAt > deadlineMs) {
      timedOut = true;
      break;
    }
    let result: GymTurnResult | undefined;
    for (let attemptNo = 0; attemptNo <= maxReasks; attemptNo++) {
      callCount++;
      try {
        result = await options.turn({ turnIndex, repoDir: task.repoDir, visibleTestPath, systemPrompt, userPrompt, transcript: [...transcript], tools: GYM_TOOL_DEFINITIONS });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = typeof (error as { attempts?: unknown })?.attempts === "number"
          ? (error as { attempts: number }).attempts
          : 1;
        httpAttempts += attempts;
        const classified = classifyFailure(error, message);
        if (classified.kind === "malformed" && attemptNo < maxReasks) {
          reasks++;
          // Re-ask once with an explicit correction. The failure is usually a
          // stochastic formatting slip, not a property of the task.
          transcript.push({ role: "tool", name: "harness", content: 'Your previous reply was not valid JSON. Reply with ONLY {"tool_calls":[...]}.' });
          continue;
        }
        errored = message;
        failure = classified;
        break;
      }
    }
    if (errored !== undefined) break;
    const turnResult = result as GymTurnResult;
    turns++;
    httpAttempts += turnResult.attempts ?? 1;
    if (turnResult.requestedModel) requestedModel = turnResult.requestedModel;
    if (turnResult.servedModel !== undefined) servedModel = turnResult.servedModel;
    if (turnResult.modelSubstituted) modelSubstituted = true;

    const assistantContent = turnResult.content ?? JSON.stringify({ tool_calls: turnResult.toolCalls });
    transcript.push({ role: "assistant", content: assistantContent });

    for (const call of turnResult.toolCalls) {
      if (call.name === "finish") {
        finished = true;
        break;
      }
      const toolResult = await tools.execute(call);
      transcript.push({ role: "tool", name: call.name, content: toolResult.observation });
      options.onTool?.({ turnIndex, call, ok: toolResult.ok, observation: toolResult.observation });
    }
    if (finished) break;
    if (options.checkpoint && options.checkpointKey) {
      try {
        const checkpointPatch = await harvestPatch(runner, { repoDir: task.repoDir, baseRef: "HEAD" });
        lastCheckpointDigest = await options.checkpoint.save(options.checkpointKey, {
          turnIndex: turnIndex + 1,
          patchText: checkpointPatch,
          transcript: [...transcript],
          requestedModel,
          servedModel,
          ...(lastCheckpointDigest ? { parentDigest: lastCheckpointDigest } : {}),
        });
      } catch {
        // A checkpoint failure only weakens resume; it must not fail the attempt.
      }
    }
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
        // The gym's pass decision is the ISOLATED verifier: it runs agent code
        // in a worker that never sees the expected outputs and never holds a
        // secret, and decides by comparing returned values. The harness-based
        // in-process scorer is deliberately not a fallback here — agent code can
        // import that harness and call its own complete(). A task with no
        // held-out cases is `errored`, not scored.
        const cases = task.task.hiddenCases ?? [];
        const scorer: GymScorer = options.score ?? ((request) => isolatedScoreGymPatch({
          patchText: request.patchText,
          baseRepoDir: request.baseRepoDir,
          cases,
          ...(options.nodeBin ? { nodeBin: options.nodeBin } : {}),
        }));
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
  if (timedOut && failure === undefined) failure = { message: "attempt exceeded its deadline", transient: true, kind: "transient" };

  return {
    outcome,
    requestedModel,
    servedModel,
    modelSubstituted,
    wallTimeMs: now() - startedAt,
    callCount,
    httpAttempts,
    turns,
    reasks,
    ...(resumedFromTurn !== undefined ? { resumedFromTurn } : {}),
    protectedPathsTouched,
    patch,
    score,
    ...(errored !== undefined ? { error: errored } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

const TRANSIENT_RE = /HTTP 5\d\d|HTTP 429|abort|timed? ?out|timeout|ECONN|socket hang up|fetch failed|network/i;
const MALFORMED_RE = /not JSON|in JSON|no tool_calls|tool_calls array|arguments are not JSON|has no name|model reply has no|Unexpected token|Unexpected end of JSON/i;

/**
 * Classify a thrown turn error.
 *
 * Provider/network failures (5xx, 429, timeout, reset) are `transient`: the
 * durable arm retries and can park on a server hint. A malformed/truncated
 * model reply is `malformed`: the runner re-asks once, but if the re-ask is also
 * bad the attempt fails — it is deliberately not handed to the durable retry
 * budget, because a model that reliably emits bad JSON would otherwise burn that
 * budget every turn. Anything else is `fatal`. Failures this makes
 * unrecoverable: a second malformed reply in one attempt, and any non-provider,
 * non-JSON error.
 */
function classifyFailure(error: unknown, message: string): GymFailure {
  const retryAfterMs = typeof (error as { retryAfterMs?: unknown })?.retryAfterMs === "number"
    ? ((error as { retryAfterMs: number }).retryAfterMs)
    : undefined;
  if (retryAfterMs !== undefined || TRANSIENT_RE.test(message)) {
    return { message, transient: true, kind: "transient", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (MALFORMED_RE.test(message)) return { message, transient: false, kind: "malformed" };
  return { message, transient: false, kind: "fatal" };
}
