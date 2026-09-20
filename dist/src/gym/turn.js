const TOOL_NAMES = ["list_files", "read_file", "write_file", "run_visible_test", "finish"];
function coerceToolCalls(value) {
    if (!Array.isArray(value))
        throw new Error("model reply has no tool_calls array");
    return value.map((entry, index) => {
        const item = entry;
        if (typeof item?.name !== "string")
            throw new Error(`tool call ${index} has no name`);
        if (!TOOL_NAMES.includes(item.name))
            throw new Error(`unknown tool: ${item.name}`);
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
function extractToolCalls(content) {
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
 * The plain arm: a direct call to an OpenAI-compatible gateway. No Temporal, no
 * retry, no receipts. The prompt is the shared gym prompt, so this arm and the
 * durable arm differ only in durability.
 */
export function createGatewayGymTurn(options) {
    const doFetch = options.fetchImpl ?? fetch;
    const url = `${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    const timeoutMs = options.timeoutMs ?? 120_000;
    return async function gatewayGymTurn(input) {
        const startedAt = Date.now();
        const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
        if (options.apiKey)
            headers.authorization = `Bearer ${options.apiKey}`;
        const messages = [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
            ...input.transcript.map((entry) => entry.role === "assistant"
                ? { role: "assistant", content: entry.content }
                : { role: "user", content: `Observation from ${entry.name ?? "tool"}:\n${entry.content}` }),
        ];
        const response = await doFetch(url, {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({ model: options.model, messages, temperature: 0 }),
        });
        const text = await response.text();
        if (!response.ok)
            throw new Error(`gateway returned HTTP ${response.status}: ${text.slice(0, 300)}`);
        const body = JSON.parse(text);
        const message = body.choices?.[0]?.message;
        let toolCalls;
        if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
            toolCalls = coerceToolCalls(message.tool_calls.map((call) => ({ name: call.function?.name, arguments: call.function?.arguments })));
        }
        else if (typeof message?.content === "string" && message.content.length > 0) {
            toolCalls = extractToolCalls(message.content);
        }
        else {
            throw new Error("gateway reply had neither content nor tool_calls");
        }
        const servedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
        return {
            toolCalls,
            content: message?.content ?? JSON.stringify({ tool_calls: toolCalls }),
            requestedModel: options.model,
            servedModel,
            modelSubstituted: servedModel !== null && servedModel !== options.model,
            latencyMs: Date.now() - startedAt,
            ...(body.usage !== undefined ? { usage: body.usage } : {}),
        };
    };
}
