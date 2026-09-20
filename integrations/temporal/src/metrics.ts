/**
 * Custom Temporal metrics for the runtime turn.
 *
 * Instruments are created lazily from the worker's `MetricMeter`, which only
 * exists once the SDK Core runtime is installed (i.e. inside a worker process).
 * Outside one — unit tests, direct callers — the helpers are no-ops, so they
 * can be called unconditionally.
 *
 * The SDK already emits the workflow/activity counters, latency and retry
 * metrics (see `docs/OBSERVABILITY.md`); these add the runtime-specific model
 * and execution-rung series.
 */
import type { MetricCounter, MetricHistogram, MetricMeter, MetricTags } from "@temporalio/common";
import { Runtime } from "@temporalio/worker";

interface Instruments {
  modelCalls: MetricCounter;
  modelLatency: MetricHistogram;
  effectLatency: MetricHistogram;
  activityRetries: MetricCounter;
}

let cached: Instruments | undefined;

function meter(): MetricMeter | undefined {
  try {
    return Runtime.instance().metricMeter;
  } catch {
    // Core is not installed (unit test / direct caller): stay silent.
    return undefined;
  }
}

function instruments(): Instruments | undefined {
  if (cached) return cached;
  const m = meter();
  if (!m) return undefined;
  cached = {
    modelCalls: m.createCounter("synth_model_calls", "{call}", "Model calls issued by the runtime turn body"),
    modelLatency: m.createHistogram("synth_model_latency", "int", "ms", "Model call latency"),
    effectLatency: m.createHistogram("synth_effect_latency", "int", "ms", "Execution-rung effect latency"),
    activityRetries: m.createCounter("synth_activity_retries", "{retry}", "Temporal activity retries"),
  };
  return cached;
}

/** One model call: count + latency. */
export function recordModelCall(latencyMs: number, tags: MetricTags = {}): void {
  const i = instruments();
  if (!i) return;
  i.modelCalls.add(1, tags);
  i.modelLatency.record(latencyMs, tags);
}

/** One execution-rung effect: latency, tagged by effect kind and executor. */
export function recordEffect(latencyMs: number, tags: MetricTags = {}): void {
  instruments()?.effectLatency.record(latencyMs, tags);
}

/** A Temporal activity attempt that is a retry (attempt > 1). */
export function recordActivityRetry(tags: MetricTags = {}): void {
  instruments()?.activityRetries.add(1, tags);
}
