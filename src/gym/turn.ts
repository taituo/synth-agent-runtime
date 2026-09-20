/**
 * Turn implementations. A turn is the only model boundary the shared attempt
 * loop knows about, so the same loop serves every arm:
 *
 *   - `createScriptedGymTurn` — a fake model with a fixed script. Zero cost;
 *     this is what `--dry-run` and the unit tests use.
 *   - `createGatewayGymTurn` — a THIN adapter over the runtime's one turn body,
 *     `GatewayAgentEngine` (`src/runtime/gateway-engine.ts`). It does not build
 *     a `/v1/chat/completions` request itself; it configures the shared engine
 *     with the gym's system prompt and tool-call parser. The bounded transient
 *     retry (the same thing any real HTTP client does) stays here, opt-in via
 *     `retry`, so the two arms differ only in durability.
 *   - the durable arm lives in `integrations/temporal` and runs the same shared
 *     engine through the `runTurn` activity.
 *
 * All of them return tool calls in the same shape, and the plain/durable arms
 * share the same system prompt via `buildGymSystemPrompt`.
 */
import type { AgentMessage } from "../core/types.js";
import type { AgentEngineContext } from "../runtime/agent-engine.js";
import { createGatewayAgentEngine, type GatewayToolCall } from "../runtime/gateway-engine.js";
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

/** The gym's tool-call protocol: a JSON reply carrying `tool_calls`. */
export function parseGymToolCalls(content: string): GymToolCall[] {
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
 * The plain arm: a direct call to an OpenAI-compatible gateway, made by the
 * runtime's shared turn body. This function only configures `GatewayAgentEngine`
 * (system prompt, tool-call parser, model/endpoint) and maps its outcome back to
 * the gym's turn shape; it does NOT build an HTTP request. With `retry` omitted
 * it is a single shot; with the shared `DEFAULT_GATEWAY_RETRY` it does the
 * bounded transient retry a normal HTTP client does, so it is a fair control
 * against the durable arm. The prompt is the shared gym prompt either way.
 */
export function createGatewayGymTurn(options: GatewayGymTurnOptions): GymTurn {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 1);
  const baseDelayMs = options.retry?.baseDelayMs ?? 250;
  const maxDelayMs = options.retry?.maxDelayMs ?? 5_000;
  const sleepImpl = options.retry?.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function callOnce(input: GymTurnInput, startedAt: number, attempts: number): Promise<GymTurnResult> {
    // Render the transcript into the single user message the shared body sends.
    const userText = [
      input.userPrompt,
      ...input.transcript.map((entry) =>
        entry.role === "assistant" ? entry.content : `Observation from ${entry.name ?? "tool"}:\n${entry.content}`,
      ),
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
      parseToolCalls: (content) => parseGymToolCalls(content) as GatewayToolCall[],
      // No `toEffect`: the gym loop executes the returned calls through its
      // runner (the sandbox rung), not the engine. The engine is the one model
      // body; the loop owns tool dispatch so `replace_in_file`/`finish` keep
      // their gym semantics.
    });

    const context: AgentEngineContext = {
      agentId: "gym-agent" as never,
      workspaceId: "gym-workspace" as never,
      definition: { id: "gym-agent", inferenceProfile: { id: options.model, model: options.model } },
      inferenceProfile: { id: options.model, model: options.model },
      signal: new AbortController().signal,
      emitOutput: () => {},
      emitTool: () => {},
    };
    const outcome = await engine.run([] as readonly AgentMessage[], context);
    const toolCalls = outcome.toolCalls as GymToolCall[];
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
