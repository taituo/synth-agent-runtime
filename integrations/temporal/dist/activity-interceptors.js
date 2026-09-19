import { randomUUID } from "node:crypto";
import { agentIdFromArgs, compactCorrelation, messageKindFromArgs, rootCauseMessage, } from "./correlation.js";
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
const lastFailure = new Map();
function rememberFailure(key, message) {
    lastFailure.delete(key); // re-inserting moves it to the end (most-recently-used)
    lastFailure.set(key, message);
    if (lastFailure.size > MAX_LAST_FAILURE_ENTRIES) {
        const oldest = lastFailure.keys().next().value;
        if (oldest !== undefined)
            lastFailure.delete(oldest);
    }
}
/**
 * Worker-side activity interceptors. Every activity log line gains the Synth
 * correlation fields (`agentId`, `workflowId`, `activityType`, `attempt`, and
 * `retryReason` on retries), and every attempt emits a trace span to the
 * configured sink.
 */
export function createSynthActivityInterceptors(options = {}) {
    return (ctx) => {
        const info = ctx.info;
        const correlation = {
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
            if (previous)
                correlation.retryReason = previous;
        }
        const traceId = () => options.traceIdFor?.(correlation) ?? correlation.workflowId ?? correlation.agentId ?? "temporal-activity";
        const emit = async (name, phase, attributes, spanId) => {
            if (!options.trace)
                return;
            await options.trace.emit({
                traceId: traceId(),
                spanId,
                name,
                phase,
                at: Date.now(),
                attributes: { ...compactCorrelation(correlation), ...attributes },
            });
        };
        const inbound = {
            async execute(input, next) {
                const agentId = agentIdFromArgs(input.args);
                if (agentId)
                    correlation.agentId = agentId;
                const messageKind = messageKindFromArgs(input.args);
                if (messageKind)
                    correlation.messageKind = messageKind;
                const spanName = `temporal.activity.${info.activityType}`;
                const spanId = `${info.activityType}-${randomUUID()}`;
                const startedAt = Date.now();
                await emit(spanName, "start", {}, spanId);
                try {
                    const result = await next(input);
                    await emit(spanName, "end", { durationMs: Date.now() - startedAt }, spanId);
                    lastFailure.delete(failureKey);
                    return result;
                }
                catch (error) {
                    const message = rootCauseMessage(error);
                    correlation.retryReason = message;
                    const willRetry = options.maxAttempts !== undefined ? info.attempt < options.maxAttempts : undefined;
                    if (willRetry === false)
                        lastFailure.delete(failureKey);
                    else
                        rememberFailure(failureKey, message);
                    await emit(spanName, "error", { durationMs: Date.now() - startedAt, error: message, willRetry }, spanId);
                    throw error;
                }
            },
        };
        const outbound = {
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
