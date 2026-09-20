import type { AgentMessage } from "../core/types.js";
import type { Effect } from "../execution/types.js";
import { parseRetryHintMs } from "../inference/gateway/retry-hint.js";
import type { AgentEngine, AgentEngineContext } from "./agent-engine.js";

/**
 * The shared turn body for a gateway-backed agent.
 *
 * One turn is: send the turn's messages to an OpenAI-compatible gateway, then
 * execute the tool calls the model asked for through the execution rung
 * (`AgentEngineContext.executeEffect`), and return the outcome. Both the
 * in-process driver (`AgentRuntime`) and the durable `runTurn` activity call
 * this engine; neither is allowed to hand-roll the model HTTP call.
 */

export interface GatewayToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface GatewayToolObservation {
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface GatewayUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface GatewayTurnOutcome {
  /** The assistant's raw content, the input to any consumer-specific parsing. */
  content: string;
  toolCalls: GatewayToolCall[];
  observations: GatewayToolObservation[];
  requestedModel: string;
  /** The model the upstream said answered, or null when it did not say. */
  servedModel: string | null;
  /** True only when the upstream named a model different from the requested one. */
  modelSubstituted: boolean;
  latencyMs: number;
  usage?: GatewayUsage;
}

/** A non-2xx gateway reply, carrying the status for retry-policy decisions. */
export class GatewayHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export interface GatewayAgentEngineOptions {
  /** Base URL of the gateway, without a trailing path (e.g. http://127.0.0.1:8787). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Per-request timeout. Reasoning models can take tens of seconds. Default 120s. */
  timeoutMs?: number;
  /** How often to heartbeat while waiting on the model. Default 10s. */
  heartbeatIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Milestone hook (e.g. a Temporal activity heartbeat). */
  heartbeat?: () => void;
  /** The system prompt for this agent. */
  systemPrompt: string;
  /** Render the turn's messages into the single user message sent to the model. */
  buildUserMessage(messages: readonly AgentMessage[]): string;
  /**
   * Parse the assistant content into tool calls. The default reads the
   * `tool_calls` array from a JSON reply and tolerates a code fence/prose.
   * A consumer with no tools (e.g. event triage) gets an empty list.
   */
  parseToolCalls?: (content: string) => GatewayToolCall[];
  /**
   * Map one model tool call to an execution-rung `Effect`. Returning undefined
   * leaves the call unexecuted (recorded as a refused observation).
   */
  toEffect?: (call: GatewayToolCall, context: AgentEngineContext, index: number) => Effect | undefined;
  /** Called once per successful turn, with the turn's outcome. */
  onTurn?: (outcome: GatewayTurnOutcome, context: AgentEngineContext) => void;
}

function coerceToolCalls(value: unknown): GatewayToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const item = entry as { name?: unknown; arguments?: unknown; args?: unknown };
    if (typeof item?.name !== "string") throw new Error(`tool call ${index} has no name`);
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
    return { name: item.name, arguments: args };
  });
}

/** Default tool-call parser: a JSON reply carrying an optional `tool_calls` array. */
export function parseToolCallsFromContent(content: string): GatewayToolCall[] {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    parsed = JSON.parse(stripped.slice(start, end + 1));
  }
  if (Array.isArray(parsed)) return coerceToolCalls(parsed);
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as { tool_calls?: unknown; toolCalls?: unknown };
  return coerceToolCalls(record.tool_calls ?? record.toolCalls);
}

export class GatewayAgentEngine implements AgentEngine {
  readonly #options: GatewayAgentEngineOptions;
  readonly #doFetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #url: string;

  constructor(options: GatewayAgentEngineOptions) {
    this.#options = options;
    this.#doFetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.#url = `${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  }

  async run(messages: readonly AgentMessage[], context: AgentEngineContext): Promise<GatewayTurnOutcome> {
    const startedAt = Date.now();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#options.apiKey) headers.authorization = `Bearer ${this.#options.apiKey}`;

    this.#options.heartbeat?.();
    const timer = this.#options.heartbeat ? setInterval(this.#options.heartbeat, this.#heartbeatIntervalMs) : undefined;
    let body: {
      choices?: Array<{ message?: { content?: string | null } }>;
      model?: string;
      usage?: GatewayUsage;
    };
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
    } finally {
      if (timer) clearInterval(timer);
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) throw new Error("gateway reply had no message content");

    const toolCalls = (this.#options.parseToolCalls ?? parseToolCallsFromContent)(content);
    const observations: GatewayToolObservation[] = [];
    for (let index = 0; index < toolCalls.length; index++) {
      const call = toolCalls[index]!;
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
    const outcome: GatewayTurnOutcome = {
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

export function createGatewayAgentEngine(options: GatewayAgentEngineOptions): GatewayAgentEngine {
  return new GatewayAgentEngine(options);
}
