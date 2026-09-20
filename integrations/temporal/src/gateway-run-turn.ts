import { ApplicationFailure, Context as ActivityContext } from "@temporalio/activity";
import type { AgentActivities, DurableMailboxMessage, RunTurnInput, RunTurnResult } from "./contracts.js";
import { parseRetryHintMs } from "./retry-hints.js";

/**
 * HTTP statuses that will never succeed on retry (bad request, auth, missing
 * route/model, validation). Everything else — 408/409/425/429, 5xx, timeouts,
 * network errors, empty or malformed completions — is treated as transient and
 * left to Temporal's retry policy and, after that, the workflow's park/backoff.
 */
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 422]);

/**
 * A `runTurn` activity that does REAL inference through an OpenAI-compatible
 * gateway (this repo's own gateway, or any Chat Completions endpoint).
 *
 * Task given to the model: classify each event in the turn's batch. The typed
 * `kind` tag on a message is deliberately NEVER sent to the model, so it stays
 * a planted ground truth a driver can score the model's answers against.
 *
 * A turn can carry several messages: inference is slow relative to how fast
 * signals arrive, so events accumulate in the mailbox while a turn is in flight
 * and the next turn takes them as one batch. The model is therefore asked for
 * one classification per event, in order.
 *
 * Failure handling is intentionally plain: any HTTP error, timeout, or
 * structurally invalid answer throws, and Temporal's retry policy on the
 * workflow's activity proxy decides what happens next. While waiting on the
 * model the activity heartbeats, because the workflow configures a heartbeat
 * timeout and a slow (reasoning) model would otherwise be failed for silence.
 */

export const EVENT_CLASSES = ["news", "social_post", "incident"] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

export interface EventClassification {
  classification: string;
  reaction: string;
}

export interface GatewayTurnRecord {
  agentId: string;
  attempt: number;
  /** Planted kinds of the messages in this batch, in order (never sent to the model). */
  plantedKinds: Array<string | null>;
  classifications: EventClassification[];
  model: string;
  latencyMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface GatewayRunTurnOptions {
  /** Base URL of the gateway, without a trailing path (e.g. http://127.0.0.1:8787). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Per-request timeout. Reasoning models can take tens of seconds. Default 120s. */
  timeoutMs?: number;
  /** How often to heartbeat while waiting on the model. Default 10s. */
  heartbeatIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Overridable for tests; the default heartbeats the current Temporal activity. */
  heartbeat?: () => void;
  /** Called with one record per successful turn (in-process observers, e.g. a live driver). */
  onTurn?: (record: GatewayTurnRecord) => void;
}

export const TRIAGE_SYSTEM_PROMPT = [
  "You triage a stream of events for an operations desk.",
  "Classify each event into exactly one class:",
  '- "news": factual reporting or an announcement from an institution or news outlet.',
  '- "social_post": an informal, personal post from an individual on social media.',
  '- "incident": an operational alert about a system failure or degradation that needs action.',
  "For each event also give a short reaction (at most 12 words) describing what the desk should do.",
  'Reply with ONLY a JSON object of the form {"events":[{"classification":"news|social_post|incident","reaction":"..."}]}',
  "containing exactly one entry per event, in the same order as the events were listed.",
  "No prose, no markdown, no code fences.",
].join("\n");

export function buildTriageUserMessage(messages: readonly DurableMailboxMessage[]): string {
  const lines = messages.map((message, index) => `${index + 1}. ${message.text}`);
  return `Classify these ${messages.length} event(s), in order:\n${lines.join("\n")}`;
}

/** Tolerates a model wrapping its JSON in a code fence or a line of prose. */
export function extractJsonObject(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
    throw new Error(`model reply is not JSON: ${stripped.slice(0, 200)}`);
  }
}

export function parseClassifications(text: string, expected: number): EventClassification[] {
  const parsed = extractJsonObject(text) as { events?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.events)) {
    throw new Error(`model reply has no "events" array: ${text.slice(0, 200)}`);
  }
  if (parsed.events.length !== expected) {
    throw new Error(`model returned ${parsed.events.length} classifications for ${expected} events`);
  }
  return parsed.events.map((entry, index) => {
    const item = entry as { classification?: unknown; reaction?: unknown };
    if (typeof item?.classification !== "string") {
      throw new Error(`event ${index + 1} has no string classification`);
    }
    return { classification: item.classification.trim().toLowerCase(), reaction: typeof item.reaction === "string" ? item.reaction : "" };
  });
}

function defaultHeartbeat(): void {
  try {
    ActivityContext.current().heartbeat();
  } catch {
    // Not inside an activity (unit tests): nothing to heartbeat.
  }
}

function currentAttempt(): number {
  try {
    return ActivityContext.current().info.attempt;
  } catch {
    return 1;
  }
}

export function createGatewayRunTurn(options: GatewayRunTurnOptions): AgentActivities["runTurn"] {
  const doFetch = options.fetchImpl ?? fetch;
  const heartbeat = options.heartbeat ?? defaultHeartbeat;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  const url = `${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  return async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const startedAt = Date.now();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

    heartbeat();
    const timer = setInterval(heartbeat, heartbeatIntervalMs);
    let body: {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: GatewayTurnRecord["usage"];
      model?: string;
    };
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: "system", content: TRIAGE_SYSTEM_PROMPT },
            { role: "user", content: buildTriageUserMessage(input.messages) },
          ],
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        const message = `gateway returned HTTP ${response.status}: ${text.slice(0, 300)}`;
        if (PERMANENT_HTTP_STATUSES.has(response.status)) {
          throw ApplicationFailure.nonRetryable(message, `GatewayHTTP${response.status}`);
        }
        const retryAfterMs = parseRetryHintMs(response.headers);
        if (retryAfterMs !== undefined && (response.status === 429 || response.status === 503)) {
          // Carry the server's reset hint across the activity boundary so the
          // workflow waits for the real window instead of a blind backoff.
          throw ApplicationFailure.create({ message, type: "RateLimited", details: [{ retryAfterMs }] });
        }
        throw new Error(message);
      }
      body = JSON.parse(text);
    } finally {
      clearInterval(timer);
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) throw new Error("gateway reply had no message content");
    const classifications = parseClassifications(content, input.messages.length);

    const record: GatewayTurnRecord = {
      agentId: input.agentId,
      attempt: currentAttempt(),
      plantedKinds: input.messages.map((message) => message.kind ?? null),
      classifications,
      model: body.model ?? options.model,
      latencyMs: Date.now() - startedAt,
      ...(body.usage ? { usage: body.usage } : {}),
    };
    options.onTurn?.(record);
    return { result: { classifications, latencyMs: record.latencyMs }, state: "idle" };
  };
}
