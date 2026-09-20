/**
 * The swarm's model boundary: a gateway turn that returns swarm tool calls.
 *
 * Mirrors `createGatewayGymTurn` (same OpenAI-compatible request, same
 * requested/served model accounting) but parses calls against the swarm tool
 * surface. The swarm and the gym share the loop and the runner; only the tool
 * names and the terminal step differ.
 */
import type { SwarmTurn, SwarmTurnInput, SwarmTurnResult } from "./attempt.js";
import type { SwarmToolCall } from "./tools.js";

export interface GatewaySwarmTurnOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

const SWARM_TOOL_NAMES = new Set(["list_events", "read_event", "report_finding", "finish"]);

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // fall through to empty arguments
    }
  }
  return {};
}

/**
 * Turn raw model `tool_calls` into swarm calls. Unknown names pass through so the
 * loop can report them as the model's mistake rather than silently dropping them.
 */
export function coerceSwarmToolCalls(raw: Array<{ name?: unknown; arguments?: unknown }>): SwarmToolCall[] {
  return raw
    .filter((call) => typeof call.name === "string" && call.name.length > 0)
    .map((call) => ({ name: call.name as SwarmToolCall["name"], arguments: parseArguments(call.arguments) }));
}

/**
 * Recover tool calls a model wrote as text (some models answer in content with a
 * JSON blob or a fenced block instead of a structured tool_calls array).
 */
export function extractSwarmToolCalls(content: string): SwarmToolCall[] {
  const text = content.replace(/```(?:json)?/g, "").trim();
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(text));
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        candidates.push(JSON.parse(text.slice(start, end + 1)));
      } catch {
        // no parseable object
      }
    }
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return coerceSwarmToolCalls(candidate as Array<{ name?: unknown; arguments?: unknown }>);
    if (candidate && typeof candidate === "object") {
      const record = candidate as { tool_calls?: unknown; toolCalls?: unknown; name?: unknown; arguments?: unknown };
      const list = Array.isArray(record.tool_calls) ? record.tool_calls : Array.isArray(record.toolCalls) ? record.toolCalls : undefined;
      if (list) return coerceSwarmToolCalls(list as Array<{ name?: unknown; arguments?: unknown }>);
      if (typeof record.name === "string") return coerceSwarmToolCalls([record]);
    }
  }
  return [];
}

export function createGatewaySwarmTurn(options: GatewaySwarmTurnOptions): SwarmTurn {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return async function gatewaySwarmTurn(input: SwarmTurnInput): Promise<SwarmTurnResult> {
    const startedAt = Date.now();
    const headers: Record<string, string> = { "content-type": "application/json", ...(options.headers ?? {}) };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    const messages = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
      ...input.transcript.map((entry) =>
        entry.role === "assistant"
          ? { role: "assistant", content: entry.content }
          : { role: "user", content: `Observation from ${entry.name ?? "tool"}:\n${entry.content}` },
      ),
    ];
    const response = await doFetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: options.model, messages, temperature: 0, max_tokens: options.maxTokens ?? 4096 }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`gateway returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
      usage?: unknown;
    };
    const message = body.choices?.[0]?.message;
    let toolCalls: SwarmToolCall[];
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      toolCalls = coerceSwarmToolCalls(message.tool_calls.map((call) => ({ name: call.function?.name, arguments: call.function?.arguments })));
    } else if (typeof message?.content === "string" && message.content.length > 0) {
      toolCalls = extractSwarmToolCalls(message.content);
      if (toolCalls.length === 0) toolCalls = [{ name: "finish", arguments: {} }];
    } else {
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

/** The tool names the swarm exposes; exported for the driver's prompt/description checks. */
export function isSwarmToolName(name: string): boolean {
  return SWARM_TOOL_NAMES.has(name);
}
