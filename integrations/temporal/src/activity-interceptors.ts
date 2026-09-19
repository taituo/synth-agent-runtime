import { randomUUID } from "node:crypto";
import type { ActivityInterceptors, ActivityInterceptorsFactory } from "@temporalio/worker";
import { agentIdFromArgs, compactCorrelation, rootCauseMessage, type SynthCorrelation } from "./correlation.js";

/**
 * Structural mirror of `src/observability/trace.ts` `TraceEvent`/`TraceSink`.
 * Declared locally (not imported) because this integration is a standalone
 * package; a caller can pass the runtime's own `InMemoryTraceSink` /
 * `JsonlTraceSink` directly since the shapes are identical.
 */
export interface SynthTraceEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  phase: "start" | "event" | "end" | "error";
  at: number;
  attributes?: Record<string, unknown>;
}

export interface SynthTraceSink {
  emit(event: SynthTraceEvent): Promise<void> | void;
}

export interface SynthActivityInterceptorOptions {
  /** Optional Synth trace sink; receives one span per activity attempt. */
  trace?: SynthTraceSink;
  /** Override the trace id (defaults to workflowId, then agentId). */
  traceIdFor?: (correlation: SynthCorrelation) => string;
  /** Retry policy's maximumAttempts, used to annotate `willRetry` on failures. */
  maxAttempts?: number;
}

/**
 * Tracks the last failure per activity so a retry attempt can report *why* it
 * is being retried. Keyed by workflow/run/activity so parallel workflows do
 * not contaminate each other.
 *
 * Entries are removed on success, and also on a failure known to be the
 * final attempt (`willRetry === false`, i.e. `maxAttempts` was supplied and
 * this attempt reached it) since no future retry will ever read them. When
 * `maxAttempts` isn't supplied, or a workflow is cancelled/times out instead
 * of running a final attempt, neither cleanup path fires; MAX_ENTRIES bounds
 * the map's growth in that case by evicting the oldest entry (Map preserves
 * insertion order), rather than letting a long-lived worker process leak
 * memory indefinitely.
 */
const MAX_LAST_FAILURE_ENTRIES = 5_000;
const lastFailure = new Map<string, string>();

function rememberFailure(key: string, message: string): void {
  lastFailure.delete(key); // re-inserting moves it to the end (most-recently-used)
  lastFailure.set(key, message);
  if (lastFailure.size > MAX_LAST_FAILURE_ENTRIES) {
    const oldest = lastFailure.keys().next().value;
    if (oldest !== undefined) lastFailure.delete(oldest);
  }
}

/**
 * Worker-side activity interceptors. Every activity log line gains the Synth
 * correlation fields (`agentId`, `workflowId`, `activityType`, `attempt`, and
 * `retryReason` on retries), and every attempt emits a trace span to the
 * configured sink.
 */
export function createSynthActivityInterceptors(
  options: SynthActivityInterceptorOptions = {},
): ActivityInterceptorsFactory {
  return (ctx): ActivityInterceptors => {
    const info = ctx.info;
    const correlation: SynthCorrelation = {
      workflowId: info.workflowExecution?.workflowId,
      workflowType: info.workflowType,
      runId: info.workflowExecution?.runId,
      taskQueue: info.taskQueue,
      activityId: info.activityId,
      activityType: info.activityType,
      attempt: info.attempt,
    };
    const failureKey = `${correlation.workflowId ?? "?"}:${correlation.runId ?? "?"}:${info.activityType}:${info.activityId}`;
    if (info.attempt > 1) {
      const previous = lastFailure.get(failureKey);
      if (previous) correlation.retryReason = previous;
    }

    const traceId = (): string =>
      options.traceIdFor?.(correlation) ?? correlation.workflowId ?? correlation.agentId ?? "temporal-activity";

    const emit = async (
      name: string,
      phase: SynthTraceEvent["phase"],
      attributes: Record<string, unknown>,
      spanId: string,
    ): Promise<void> => {
      if (!options.trace) return;
      await options.trace.emit({
        traceId: traceId(),
        spanId,
        name,
        phase,
        at: Date.now(),
        attributes: { ...compactCorrelation(correlation), ...attributes },
      });
    };

    const inbound: NonNullable<ActivityInterceptors["inbound"]> = {
      async execute(input, next) {
        const agentId = agentIdFromArgs(input.args);
        if (agentId) correlation.agentId = agentId;
        const spanName = `temporal.activity.${info.activityType}`;
        const spanId = `${info.activityType}-${randomUUID()}`;
        const startedAt = Date.now();
        await emit(spanName, "start", {}, spanId);
        try {
          const result = await next(input);
          await emit(spanName, "end", { durationMs: Date.now() - startedAt }, spanId);
          lastFailure.delete(failureKey);
          return result;
        } catch (error) {
          const message = rootCauseMessage(error);
          correlation.retryReason = message;
          const willRetry = options.maxAttempts !== undefined ? info.attempt < options.maxAttempts : undefined;
          if (willRetry === false) lastFailure.delete(failureKey);
          else rememberFailure(failureKey, message);
          await emit(spanName, "error", { durationMs: Date.now() - startedAt, error: message, willRetry }, spanId);
          throw error;
        }
      },
    };

    const outbound: NonNullable<ActivityInterceptors["outbound"]> = {
      getLogAttributes(input, next) {
        return { ...next(input), ...compactCorrelation(correlation) };
      },
      getMetricTags(input, next) {
        return {
          ...next(input),
          agentId: correlation.agentId ?? "unknown",
          workflowId: correlation.workflowId ?? "unknown",
          activityType: info.activityType,
          attempt: info.attempt,
        };
      },
    };

    return { inbound, outbound };
  };
}
