/**
 * Synth correlation fields for Temporal logs and traces.
 *
 * This module is imported from BOTH the workflow isolate (via the bundled
 * workflow-interceptors module) and normal Node worker code (activity
 * interceptors), so it must stay sandbox-safe: no `node:*` imports, no I/O,
 * no globals outside the ECMAScript baseline.
 *
 * The field names mirror the correlation model in `docs/OBSERVABILITY.md`
 * (`agent_id`, `workflow_id`, `turn_id`, `attempt_id`, ...) so Temporal
 * telemetry lines up with the runtime's own `TraceEvent.attributes` rather
 * than inventing a second naming scheme.
 */
export interface SynthCorrelation {
  /** Synth agent id; the logical resource the workflow/activity serves. */
  agentId?: string;
  /** Temporal workflow id (the durable `agent/<agentId>` handle). */
  workflowId?: string;
  /** Temporal workflow type (e.g. `durableAgentWorkflow`). */
  workflowType?: string;
  /** Temporal workflow run id. */
  runId?: string;
  /** Temporal task queue. */
  taskQueue?: string;
  /** Temporal activity id. */
  activityId?: string;
  /** Temporal activity type (e.g. `runTurn`). */
  activityType?: string;
  /** 1-based activity attempt; >1 means this execution is a retry. */
  attempt?: number;
  /** Root-cause message of the previous failed attempt, when this is a retry. */
  retryReason?: string;
  /**
   * Typed-event tag of the message driving this turn (the last mailbox message
   * in the activity/workflow input). Lets traces and logs be filtered by event
   * type, not just by agent.
   */
  messageKind?: string;
  /** Execution rung the turn's effects run on: `synthetic`, `sandbox`, or `none`. */
  rung?: string;
}

/** Header used to carry correlation from a workflow into its activities. */
export const SYNTH_CORRELATION_HEADER = "x-synth-correlation";

/**
 * Temporal's workflow sandbox does not expose the global `structuredClone`
 * (it runs in a restricted V8 isolate, not a full Node/browser global scope).
 * A JSON round-trip is sandbox-safe and sufficient for plain JSON-serializable
 * state (strings/numbers/arrays/plain objects, never Date/Map/Set/functions).
 */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const AGENT_WORKFLOW_PREFIX = "agent/";

/** `agent/agt_123` -> `agt_123`; a bare id is returned unchanged. */
export function agentIdFromWorkflowId(workflowId: string | undefined): string | undefined {
  if (!workflowId) return undefined;
  return workflowId.startsWith(AGENT_WORKFLOW_PREFIX) ? workflowId.slice(AGENT_WORKFLOW_PREFIX.length) : workflowId;
}

/** Pull `agentId` off a `{ agentId, ... }` activity/workflow input, if present. */
export function agentIdFromArgs(args: readonly unknown[] | undefined): string | undefined {
  const first = args?.[0];
  if (first && typeof first === "object" && "agentId" in first) {
    const value = (first as { agentId?: unknown }).agentId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readKind(value: unknown): string | undefined {
  if (value && typeof value === "object" && "kind" in value) {
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind === "string" && kind.length > 0) return kind;
  }
  return undefined;
}

/**
 * Pull the typed-event `kind` off a call's args. Handles both shapes that
 * carry a mailbox message: a `runTurn` activity input `{ messages: [...] }`
 * (uses the last, i.e. driving, message) and a bare `sendMessage` signal
 * payload. Returns undefined for legacy untyped messages, so correlation is
 * unchanged for existing signals.
 */
/**
 * Pull the rung kind off a `runTurn` input `{ config: { rung: { kind } } }`.
 * Sandbox-safe (plain property reads), so both the activity interceptors and
 * the workflow bundle can use it.
 */
export function rungFromArgs(args: readonly unknown[] | undefined): string | undefined {
  const first = args?.[0];
  if (!first || typeof first !== "object") return undefined;
  const config = (first as { config?: unknown }).config;
  if (!config || typeof config !== "object") return undefined;
  const rung = (config as { rung?: unknown }).rung;
  if (!rung) return undefined;
  if (typeof rung === "string") return rung;
  const kind = (rung as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}

export function messageKindFromArgs(args: readonly unknown[] | undefined): string | undefined {
  const first = args?.[0];
  if (!first || typeof first !== "object") return undefined;
  if ("messages" in first) {
    const messages = (first as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    return readKind(messages[messages.length - 1]);
  }
  return readKind(first);
}

/** Drop undefined fields so log attributes stay clean. */
export function compactCorrelation(correlation: SynthCorrelation): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(correlation)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * True when the failure, or any cause in its chain, is marked non-retryable
 * (e.g. an `ApplicationFailure.nonRetryable` raised by the gateway activity).
 * Sandbox-safe: inspects plain properties only, no SDK imports.
 */
export function isNonRetryableFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as { nonRetryable?: unknown }).nonRetryable === true) return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * Read a server-provided `retryAfterMs` hint off an error, or any cause in its
 * chain. The activity attaches it either as a plain property or inside an
 * `ApplicationFailure`'s `details`; both are checked so unit tests can use the
 * plain form and the live path can carry it across the activity boundary.
 */
export function retryAfterMsFromError(error: unknown): number | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const direct = (current as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof direct === "number" && Number.isFinite(direct)) return direct;
    const details = (current as { details?: unknown }).details;
    if (Array.isArray(details)) {
      for (const entry of details) {
        if (entry && typeof entry === "object") {
          const value = (entry as { retryAfterMs?: unknown }).retryAfterMs;
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
      }
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

/** Longest park a server hint may impose; beyond this it is quota exhaustion. */
export const MAX_PARK_HINT_MS = 60 * 60 * 1000;

/**
 * A usable park hint: finite, positive, and at most one hour. Anything else
 * (absent, NaN, negative, absurd) is ignored so a hostile or broken upstream
 * cannot park an agent for a week.
 */
export function clampParkHintMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value > MAX_PARK_HINT_MS) return undefined;
  return value;
}

/** Exponential park backoff bounds for transient turn failures. */
export interface ParkBackoff {
  initialMs: number;
  maxMs: number;
}

/** Defaults: 5s initial, doubling, capped at 5 minutes. */
export const DEFAULT_PARK_BACKOFF: ParkBackoff = { initialMs: 5_000, maxMs: 300_000 };

/**
 * Backoff before the `attempt`-th consecutive park (1-based). `initialMs * 2^(attempt-1)`,
 * capped at `maxMs`. Invalid/absent overrides fall back to the defaults so a
 * malformed `parkBackoff` can never produce a zero or negative wait.
 */
export function nextParkBackoffMs(attempt: number, override?: ParkBackoff): number {
  const initialMs =
    override && Number.isFinite(override.initialMs) && override.initialMs > 0
      ? override.initialMs
      : DEFAULT_PARK_BACKOFF.initialMs;
  const maxMs =
    override && Number.isFinite(override.maxMs) && override.maxMs > 0
      ? override.maxMs
      : DEFAULT_PARK_BACKOFF.maxMs;
  const raw = initialMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, Math.max(initialMs, maxMs));
}

/** Walk an error's `cause` chain and return the innermost message. */
export function rootCauseMessage(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && "cause" in current && !seen.has(current)) {
    seen.add(current);
    const cause = (current as { cause?: unknown }).cause;
    if (!cause) break;
    current = cause;
    if (current instanceof Error) message = current.message;
  }
  return message;
}
