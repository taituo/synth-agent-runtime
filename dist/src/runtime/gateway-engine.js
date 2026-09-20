import { parseRetryHintMs } from "../inference/gateway/retry-hint.js";
/** A non-2xx gateway reply, carrying the status for retry-policy decisions. */
export class GatewayHttpError extends Error {
    status;
    retryAfterMs;
    constructor(message, status, retryAfterMs) {
        super(message);
        this.name = "GatewayHttpError";
        this.status = status;
        if (retryAfterMs !== undefined)
            this.retryAfterMs = retryAfterMs;
    }
}
function coerceToolCalls(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((entry, index) => {
        const item = entry;
        if (typeof item?.name !== "string")
            throw new Error(`tool call ${index} has no name`);
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
/** Default tool-call parser: a JSON reply carrying an optional `tool_calls` array. */
export function parseToolCallsFromContent(content) {
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    let parsed;
    try {
        parsed = JSON.parse(stripped);
    }
    catch {
        const start = stripped.indexOf("{");
        const end = stripped.lastIndexOf("}");
        if (start < 0 || end <= start)
            return [];
        parsed = JSON.parse(stripped.slice(start, end + 1));
    }
    if (Array.isArray(parsed))
        return coerceToolCalls(parsed);
    if (!parsed || typeof parsed !== "object")
        return [];
    const record = parsed;
    return coerceToolCalls(record.tool_calls ?? record.toolCalls);
}
export class GatewayAgentEngine {
    #options;
    #doFetch;
    #timeoutMs;
    #heartbeatIntervalMs;
    #url;
    constructor(options) {
        this.#options = options;
        this.#doFetch = options.fetchImpl ?? fetch;
        this.#timeoutMs = options.timeoutMs ?? 120_000;
        this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
        this.#url = `${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    }
    async run(messages, context) {
        const startedAt = Date.now();
        const headers = { "content-type": "application/json" };
        if (this.#options.apiKey)
            headers.authorization = `Bearer ${this.#options.apiKey}`;
        this.#options.heartbeat?.();
        const timer = this.#options.heartbeat ? setInterval(this.#options.heartbeat, this.#heartbeatIntervalMs) : undefined;
        let body;
        try {
            const response = await this.#doFetch(this.#url, {
                method: "POST",
                headers,
                signal: AbortSignal.timeout(this.#timeoutMs),
                body: JSON.stringify({
                    model: this.#options.model,
                    messages: [
                        { role: "system", content: this.#options.systemPrompt },
                        { role: "user", content: this.#options.buildUserMessage(messages) },
                    ],
                }),
            });
            const text = await response.text();
            if (!response.ok) {
                const message = `gateway returned HTTP ${response.status}: ${text.slice(0, 300)}`;
                throw new GatewayHttpError(message, response.status, parseRetryHintMs(response.headers));
            }
            body = JSON.parse(text);
        }
        finally {
            if (timer)
                clearInterval(timer);
        }
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0)
            throw new Error("gateway reply had no message content");
        const toolCalls = (this.#options.parseToolCalls ?? parseToolCallsFromContent)(content);
        const observations = [];
        for (let index = 0; index < toolCalls.length; index++) {
            const call = toolCalls[index];
            const effect = this.#options.toEffect?.(call, context, index);
            context.emitTool(call.name, "start", call.arguments);
            if (!effect || !context.executeEffect) {
                observations.push({ name: call.name, ok: false, error: effect ? "No effect executor configured" : "No execution rung mapping for tool" });
                context.emitTool(call.name, "end", { ok: false });
                continue;
            }
            const result = await context.executeEffect(effect);
            observations.push({
                name: call.name,
                ok: result.ok,
                ...(result.output !== undefined ? { output: result.output } : {}),
                ...(result.error !== undefined ? { error: result.error } : {}),
            });
            context.emitTool(call.name, "end", { ok: result.ok });
        }
        const servedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
        const outcome = {
            content,
            toolCalls,
            observations,
            requestedModel: this.#options.model,
            servedModel,
            modelSubstituted: servedModel !== null && servedModel !== this.#options.model,
            latencyMs: Date.now() - startedAt,
            ...(body.usage ? { usage: body.usage } : {}),
        };
        this.#options.onTurn?.(outcome, context);
        return outcome;
    }
}
export function createGatewayAgentEngine(options) {
    return new GatewayAgentEngine(options);
}
