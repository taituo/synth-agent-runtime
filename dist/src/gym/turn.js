import { createGatewayAgentEngine } from "../runtime/gateway-engine.js";
function coerceToolCalls(value) {
    if (!Array.isArray(value))
        throw new Error("model reply has no tool_calls array");
    return value.map((entry, index) => {
        const item = entry;
        if (typeof item?.name !== "string")
            throw new Error(`tool call ${index} has no name`);
        // An unknown tool name is a model mistake, not a protocol error: let the
        // executor return "unknown tool" as an observation so the model can retry.
        const rawArgs = item.arguments ?? item.args ?? {};
        let args = {};
        if (typeof rawArgs === "string") {
            try {
                args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
            }
            catch {
                throw new Error(`tool call ${item.name} arguments are not JSON`);
            }
        }
        else if (rawArgs && typeof rawArgs === "object") {
            args = rawArgs;
        }
        return { name: item.name, arguments: args };
    });
}
/** The gym's tool-call protocol: a JSON reply carrying `tool_calls`. */
export function parseGymToolCalls(content) {
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    let parsed;
    try {
        parsed = JSON.parse(stripped);
    }
    catch {
        const start = stripped.indexOf("{");
        const end = stripped.lastIndexOf("}");
        if (start < 0 || end <= start)
            throw new Error(`model reply is not JSON: ${stripped.slice(0, 200)}`);
        parsed = JSON.parse(stripped.slice(start, end + 1));
    }
    const calls = parsed.tool_calls;
    const list = Array.isArray(calls) ? calls : Array.isArray(parsed) ? parsed : parsed.toolCalls;
    return coerceToolCalls(list);
}
/**
 * A deterministic fake model. Steps are consumed by turn index; once the script
 * is exhausted the turn calls `finish`, so a dry run always terminates.
 */
export function createScriptedGymTurn(steps, defaults = {}) {
    const requestedModel = defaults.requestedModel ?? "scripted";
    const servedModel = defaults.servedModel === undefined ? "scripted" : defaults.servedModel;
    return async (input) => {
        const step = steps[input.turnIndex];
        const result = typeof step === "function" ? await step(input) : step;
        if (!result) {
            return { toolCalls: [{ name: "finish" }], requestedModel, servedModel, modelSubstituted: defaults.modelSubstituted ?? false };
        }
        const finalRequested = result.requestedModel ?? requestedModel;
        const finalServed = result.servedModel === undefined ? servedModel : result.servedModel;
        const substituted = result.modelSubstituted ?? defaults.modelSubstituted;
        return {
            requestedModel: finalRequested,
            servedModel: finalServed,
            modelSubstituted: substituted ?? (finalServed !== null && finalServed !== finalRequested),
            ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            ...(result.content !== undefined ? { content: result.content } : {}),
            toolCalls: result.toolCalls,
        };
    };
}
/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined for absent/invalid values so a broken upstream cannot park
 * an attempt for an absurd time.
 */
export function parseRetryAfterMs(headers) {
    const raw = headers.get("retry-after");
    if (!raw)
        return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0)
        return seconds * 1000;
    const date = Date.parse(raw);
    if (!Number.isNaN(date))
        return Math.max(0, date - Date.now());
    return undefined;
}
/**
 * The fair-control retry config. Both arms pass this so the comparison isolates
 * durability rather than the presence of retry. Three attempts with exponential
 * backoff is what a normal HTTP client ships.
 */
export const DEFAULT_GATEWAY_RETRY = {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 5_000,
};
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_RE = /fetch failed|ECONN|socket hang up|network|timed? ?out/i;
function isRetryableNetworkError(error) {
    if (!(error instanceof Error))
        return false;
    if (error.name === "AbortError" || error.name === "TimeoutError")
        return true;
    return RETRYABLE_NETWORK_RE.test(error.message);
}
function isRetryableTurnError(error) {
    const status = error?.status;
    if (typeof status === "number")
        return RETRYABLE_STATUS.has(status);
    return isRetryableNetworkError(error);
}
/**
 * The plain arm: a direct call to an OpenAI-compatible gateway, made by the
 * runtime's shared turn body. This function only configures `GatewayAgentEngine`
 * (system prompt, tool-call parser, model/endpoint) and maps its outcome back to
 * the gym's turn shape; it does NOT build an HTTP request. With `retry` omitted
 * it is a single shot; with the shared `DEFAULT_GATEWAY_RETRY` it does the
 * bounded transient retry a normal HTTP client does, so it is a fair control
 * against the durable arm. The prompt is the shared gym prompt either way.
 */
export function createGatewayGymTurn(options) {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 1);
    const baseDelayMs = options.retry?.baseDelayMs ?? 250;
    const maxDelayMs = options.retry?.maxDelayMs ?? 5_000;
    const sleepImpl = options.retry?.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    async function callOnce(input, startedAt, attempts) {
        // Render the transcript into the single user message the shared body sends.
        const userText = [
            input.userPrompt,
            ...input.transcript.map((entry) => entry.role === "assistant" ? entry.content : `Observation from ${entry.name ?? "tool"}:\n${entry.content}`),
        ].join("\n\n");
        const engine = createGatewayAgentEngine({
            baseUrl: options.baseUrl,
            model: options.model,
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            systemPrompt: input.systemPrompt,
            buildUserMessage: () => userText,
            // The gym's tool protocol: a JSON reply carrying `tool_calls`.
            parseToolCalls: (content) => parseGymToolCalls(content),
            // No `toEffect`: the gym loop executes the returned calls through its
            // runner (the sandbox rung), not the engine. The engine is the one model
            // body; the loop owns tool dispatch so `replace_in_file`/`finish` keep
            // their gym semantics.
        });
        const context = {
            agentId: "gym-agent",
            workspaceId: "gym-workspace",
            definition: { id: "gym-agent", inferenceProfile: { id: options.model, model: options.model } },
            inferenceProfile: { id: options.model, model: options.model },
            signal: new AbortController().signal,
            emitOutput: () => { },
            emitTool: () => { },
        };
        const outcome = await engine.run([], context);
        const toolCalls = outcome.toolCalls;
        return {
            toolCalls,
            content: outcome.content ?? JSON.stringify({ tool_calls: toolCalls }),
            requestedModel: outcome.requestedModel,
            servedModel: outcome.servedModel,
            modelSubstituted: outcome.modelSubstituted,
            latencyMs: Date.now() - startedAt,
            attempts,
            ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
        };
    }
    return async function gatewayGymTurn(input) {
        const startedAt = Date.now();
        for (let attempt = 1;; attempt++) {
            try {
                return await callOnce(input, startedAt, attempt);
            }
            catch (error) {
                const tagged = error instanceof Error ? error : new Error(String(error));
                if (attempt >= maxAttempts || !isRetryableTurnError(tagged)) {
                    throw Object.assign(tagged, { attempts: attempt });
                }
                const hint = tagged.retryAfterMs;
                const backoff = hint ?? Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
                await sleepImpl(Math.min(backoff, maxDelayMs));
            }
        }
    };
}
