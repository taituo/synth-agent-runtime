import { isTampering, patchTargetPaths, PROTECTED_PATTERNS } from "./scoring.js";
import { buildGymSystemPrompt, buildGymUserPrompt, createGymTools, GYM_TOOL_DEFINITIONS } from "./tools.js";
import { harvestPatch } from "./harvest.js";
import { isolatedScoreGymPatch } from "./isolated-score.js";
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_DEADLINE_MS = 10 * 60_000;
/**
 * Run one attempt to completion and return the record the milestone reports on.
 * Never throws for an agent failure: every path returns a record, because
 * `errored`/`timed-out` are outcomes, not crashes.
 */
export async function runGymAttempt(options) {
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
    }
    catch {
        // A missing visible test is not fatal to the loop; the scorer still decides.
    }
    const userPrompt = buildGymUserPrompt({ visibleTestPath, visibleTestContent });
    const tools = createGymTools(runner, {
        visibleTestPath,
        ...(options.protectedPatterns ? { protectedPatterns: options.protectedPatterns } : {}),
        ...(options.nodeBin ? { nodeBin: options.nodeBin } : {}),
        ...(options.execTimeoutMs ? { execTimeoutMs: options.execTimeoutMs } : {}),
    });
    const transcript = [];
    let callCount = 0;
    let turns = 0;
    let finished = false;
    let timedOut = false;
    let errored;
    let failure;
    let reasks = 0;
    let requestedModel = null;
    let servedModel = null;
    let modelSubstituted = false;
    let startTurnIndex = 0;
    let resumedFromTurn;
    let lastCheckpointDigest;
    if (options.checkpoint && options.checkpointKey) {
        const saved = await options.checkpoint.load(options.checkpointKey);
        if (saved) {
            if (saved.patchText.trim().length > 0) {
                const patchPath = ".gym-checkpoint.patch";
                await runner.write(patchPath, saved.patchText);
                const applied = await runner.exec(`git apply ${patchPath}`, { cwd: task.repoDir });
                await runner.exec(`rm -f ${patchPath}`, { cwd: task.repoDir });
                if (applied.code !== 0)
                    throw new Error(`failed to restore checkpoint patch: ${applied.stderr || applied.stdout}`);
            }
            transcript.push(...saved.transcript);
            startTurnIndex = saved.turnIndex;
            resumedFromTurn = saved.turnIndex;
            lastCheckpointDigest = saved.digest;
            if (saved.requestedModel)
                requestedModel = saved.requestedModel;
            if (saved.servedModel !== undefined)
                servedModel = saved.servedModel;
        }
    }
    for (let turnIndex = startTurnIndex; turnIndex < maxTurns; turnIndex++) {
        if (now() - startedAt > deadlineMs) {
            timedOut = true;
            break;
        }
        let result;
        for (let attemptNo = 0; attemptNo <= maxReasks; attemptNo++) {
            callCount++;
            try {
                result = await options.turn({ turnIndex, repoDir: task.repoDir, visibleTestPath, systemPrompt, userPrompt, transcript: [...transcript], tools: GYM_TOOL_DEFINITIONS });
                break;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
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
        if (errored !== undefined)
            break;
        const turnResult = result;
        turns++;
        if (turnResult.requestedModel)
            requestedModel = turnResult.requestedModel;
        if (turnResult.servedModel !== undefined)
            servedModel = turnResult.servedModel;
        if (turnResult.modelSubstituted)
            modelSubstituted = true;
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
        if (finished)
            break;
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
            }
            catch {
                // A checkpoint failure only weakens resume; it must not fail the attempt.
            }
        }
        if (now() - startedAt > deadlineMs) {
            timedOut = true;
            break;
        }
    }
    let patch = "";
    let score;
    let protectedPathsTouched = [];
    if (errored !== undefined) {
        score = { outcome: "errored", touchedPaths: [], detail: errored };
    }
    else {
        try {
            patch = await harvestPatch(runner, { repoDir: task.repoDir, baseRef: "HEAD" });
            protectedPathsTouched = await patchTargetPaths(patch).then((paths) => paths.filter((path) => path === visibleTestPath || isTampering([path]) || PROTECTED_PATTERNS.some((pattern) => pattern.test(path))));
            if (patch.trim().length === 0) {
                // No changes means the planted bug is still present. Score it as `failed`
                // here rather than handing an empty patch to a scorer that may treat it
                // as malformed; this is a runner-level fact, not a scorer decision.
                score = { outcome: "failed", touchedPaths: [], detail: "no changes; the planted bug is still present" };
            }
            else {
                // The gym's pass decision is the ISOLATED verifier: it runs agent code
                // in a worker that never sees the expected outputs and never holds a
                // secret, and decides by comparing returned values. The harness-based
                // in-process scorer is deliberately not a fallback here — agent code can
                // import that harness and call its own complete(). A task with no
                // held-out cases is `errored`, not scored.
                const cases = task.task.hiddenCases ?? [];
                const scorer = options.score ?? ((request) => isolatedScoreGymPatch({
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
        }
        catch (error) {
            score = { outcome: "errored", touchedPaths: [], detail: error instanceof Error ? error.message : String(error) };
            errored = score.detail;
        }
    }
    let outcome = score.outcome;
    if (errored !== undefined)
        outcome = "errored";
    else if (timedOut)
        outcome = "timed-out";
    if (timedOut && failure === undefined)
        failure = { message: "attempt exceeded its deadline", transient: true, kind: "transient" };
    return {
        outcome,
        requestedModel,
        servedModel,
        modelSubstituted,
        wallTimeMs: now() - startedAt,
        callCount,
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
function classifyFailure(error, message) {
    const retryAfterMs = typeof error?.retryAfterMs === "number"
        ? (error.retryAfterMs)
        : undefined;
    if (retryAfterMs !== undefined || TRANSIENT_RE.test(message)) {
        return { message, transient: true, kind: "transient", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    if (MALFORMED_RE.test(message))
        return { message, transient: false, kind: "malformed" };
    return { message, transient: false, kind: "fatal" };
}
