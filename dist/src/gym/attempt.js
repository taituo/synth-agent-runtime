import { isTampering, patchTargetPaths, scoreGymPatch, PROTECTED_PATTERNS } from "./scoring.js";
import { buildGymSystemPrompt, buildGymUserPrompt, createGymTools, GYM_TOOL_DEFINITIONS } from "./tools.js";
import { harvestPatch } from "./harvest.js";
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
    let requestedModel = null;
    let servedModel = null;
    let modelSubstituted = false;
    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
        if (now() - startedAt > deadlineMs) {
            timedOut = true;
            break;
        }
        let result;
        callCount++;
        try {
            result = await options.turn({ turnIndex, repoDir: task.repoDir, visibleTestPath, systemPrompt, userPrompt, transcript: [...transcript], tools: GYM_TOOL_DEFINITIONS });
        }
        catch (error) {
            errored = error instanceof Error ? error.message : String(error);
            break;
        }
        turns++;
        if (result.requestedModel)
            requestedModel = result.requestedModel;
        if (result.servedModel !== undefined)
            servedModel = result.servedModel;
        if (result.modelSubstituted)
            modelSubstituted = true;
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
        if (finished)
            break;
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
                const scorer = options.score ?? scoreGymPatch;
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
