/**
 * Turn implementations. A turn is the only model boundary the shared attempt
 * loop knows about, so the same loop serves every arm:
 *
 *   - `createScriptedGymTurn` — a fake model with a fixed script. Zero cost;
 *     this is what `--dry-run` and the unit tests use.
 *   - `createGatewayGymTurn` — the plain arm: a direct OpenAI-compatible
 *     request. It can do a bounded transient retry/backoff (the same thing any
 *     real HTTP client does) so that a comparison against the durable arm does
 *     not measure "has any retry at all". The retry is opt-in (`retry`); with it
 *     disabled the turn is a single shot, and the two arms still differ only in
 *     durability once both are given the same `retry`.
 *   - the durable arm lives in `integrations/temporal` as a Temporal activity.
 *
 * All of them return tool calls in the same shape, and the plain/durable arms
 * share the same system prompt via `buildGymSystemPrompt`.
 */
import type { GymToolCall, GymToolName } from "./tools.js";
import type { GymTurn, GymTurnInput, GymTurnResult } from "./attempt.js";

function coerceToolCalls(value: unknown): GymToolCall[] {
  if (!Array.isArray(value)) throw new Error("model reply has no tool_calls array");
  return value.map((entry, index) => {
    const item = entry as { name?: unknown; arguments?: unknown; args?: unknown };
    if (typeof item?.name !== "string") throw new Error(`tool call ${index} has no name`);
    // An unknown tool name is a model mistake, not a protocol error: let the
    // executor return "unknown tool" as an observation so the model can retry.
    const rawArgs = item.arguments ?? item.args ?? {};
    let args: Record<string, unknown> = {};
    if (typeof rawArgs === "string") {
      try {
        args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
      } catch {
        throw new Error(`tool call ${item.name} arguments are not JSON`);
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }
    return { name: item.name as GymToolName, arguments: args };
  });
}

function extractToolCalls(content: string): GymToolCall[] {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(`model reply is not JSON: ${stripped.slice(0, 200)}`);
    parsed = JSON.parse(stripped.slice(start, end + 1));
  }
  const calls = (parsed as { tool_calls?: unknown }).tool_calls;
  const list = Array.isArray(calls) ? calls : Array.isArray(parsed) ? parsed : (parsed as { toolCalls?: unknown }).toolCalls;
  return coerceToolCalls(list);
}

export interface ScriptedTurnDefaults {
  requestedModel?: string;
  servedModel?: string | null;
  modelSubstituted?: boolean;
  latencyMs?: number;
}

export type ScriptedStep =
  | GymTurnResult
  | ((input: GymTurnInput) => GymTurnResult | Promise<GymTurnResult>);

/**
 * A deterministic fake model. Steps are consumed by turn index; once the script
 * is exhausted the turn calls `finish`, so a dry run always terminates.
 */
export function createScriptedGymTurn(steps: readonly ScriptedStep[], defaults: ScriptedTurnDefaults = {}): GymTurn {
  const requestedModel = defaults.requestedModel ?? "scripted";
  const servedModel = defaults.servedModel === undefined ? "scripted" : defaults.servedModel;
  return async (input: GymTurnInput): Promise<GymTurnResult> => {
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
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export interface GatewayGymTurnOptions {
  /** Base URL of the gateway, no trailing slash (e.g. http://127.0.0.1:8787). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Upper bound on generated tokens, so a runaway answer cannot stall a turn. */
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  /** Extra headers (e.g. tenancy/lane hints for the gateway). */
  headers?: Record<string, string>;
  /**
   * Bounded transient retry. Omit (or `maxAttempts: 1`) for the historical
   * single-shot plain arm. Both arms of a comparison must pass the same value.
   */
  retry?: GatewayRetryOptions;
}

export interface GatewayRetryOptions {
  /** Total attempts including the first. 1 disables retry. Default 1. */
  maxAttempts?: number;
  /** First backoff delay in ms; doubles each attempt. Default 250. */
  baseDelayMs?: number;
  /** Ceiling for any single backoff, including a server `Retry-After`. Default 5000. */
  maxDelayMs?: number;
  /** Injectable sleep, for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * The fair-control retry config. Both arms pass this so the comparison isolates
 * durability rather than the presence of retry. Three attempts with exponential
 * backoff is what a normal HTTP client ships.
 */
export const DEFAULT_GATEWAY_RETRY: Required<Pick<GatewayRetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs">> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_RE = /fetch failed|ECONN|socket hang up|network|timed? ?out/i;

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return RETRYABLE_NETWORK_RE.test(error.message);
}

function isRetryableTurnError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") return RETRYABLE_STATUS.has(status);
  return isRetryableNetworkError(error);
}

/**
 * The plain arm: a direct call to an OpenAI-compatible gateway. With `retry`
 * omitted it is a single shot; with the shared `DEFAULT_GATEWAY_RETRY` it does
 * the bounded transient retry a normal HTTP client does, so it is a fair control
 * against the durable arm. The prompt is the shared gym prompt either way.
 */
export function createGatewayGymTurn(options: GatewayGymTurnOptions): GymTurn {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 1);
  const baseDelayMs = options.retry?.baseDelayMs ?? 250;
  const maxDelayMs = options.retry?.maxDelayMs ?? 5_000;
  const sleepImpl = options.retry?.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function callOnce(input: GymTurnInput, startedAt: number, attempts: number): Promise<GymTurnResult> {
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
    if (!response.ok) {
      const message = `gateway returned HTTP ${response.status}: ${text.slice(0, 300)}`;
      const retryAfterMs = parseRetryAfterMs(response.headers);
      const error = Object.assign(new Error(message), { status: response.status });
      // Carry a server reset hint across the error boundary (429/503), so a
      // durable supervisor parks for the real window instead of guessing.
      if (retryAfterMs !== undefined && (response.status === 429 || response.status === 503)) {
        (error as { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
      }
      throw error;
    }
    const body = JSON.parse(text) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
      usage?: unknown;
    };
    const message = body.choices?.[0]?.message;
    let toolCalls: GymToolCall[];
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      toolCalls = coerceToolCalls(message.tool_calls.map((call) => ({ name: call.function?.name, arguments: call.function?.arguments })));
    } else if (typeof message?.content === "string" && message.content.length > 0) {
      toolCalls = extractToolCalls(message.content);
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
      attempts,
      ...(body.usage !== undefined ? { usage: body.usage } : {}),
    };
  }

  return async function gatewayGymTurn(input: GymTurnInput): Promise<GymTurnResult> {
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        return await callOnce(input, startedAt, attempt);
      } catch (error) {
        const tagged = error instanceof Error ? error : new Error(String(error));
        if (attempt >= maxAttempts || !isRetryableTurnError(tagged)) {
          throw Object.assign(tagged, { attempts: attempt });
        }
        const hint = (tagged as { retryAfterMs?: number }).retryAfterMs;
        const backoff = hint ?? Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleepImpl(Math.min(backoff, maxDelayMs));
      }
    }
  };
}
