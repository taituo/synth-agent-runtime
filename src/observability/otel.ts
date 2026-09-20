/**
 * Thin OpenTelemetry helpers.
 *
 * The runtime links against the OTel **API** only: when an application (or the
 * Temporal worker in `integrations/temporal`) registers a real provider, these
 * spans join its trace; with no provider they are cheap no-ops. That keeps the
 * runtime free of an exporter dependency while making the shared turn body,
 * the execution broker and the sandbox backend part of one trace.
 */
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

export type SpanAttributes = Record<string, unknown>;

/**
 * Resolve the tracer per call, not at module load: the runtime may be loaded
 * before the application registers its provider (and a second copy of
 * `@opentelemetry/api` may be the one that registers it), so `getTracer` at
 * import time can capture a provider that is never given a delegate.
 */
function tracer() {
  return trace.getTracer("synth-agent-runtime");
}

function setAttributes(span: Span, attributes: SpanAttributes): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    span.setAttribute(key, value as string | number | boolean);
  }
}

/** Run `body` inside a new active span, ending it and recording failures. */
export async function withSpan<T>(name: string, attributes: SpanAttributes, body: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    setAttributes(span, attributes);
    try {
      const result = await body(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}
