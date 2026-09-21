import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TraceEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  phase: "start" | "event" | "end" | "error";
  at: number;
  attributes?: Record<string, unknown>;
}

export interface TraceSink {
  emit(event: TraceEvent): Promise<void> | void;
}

export class InMemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];
  emit(event: TraceEvent): void { this.events.push(structuredClone(event)); }
}

export class JsonlTraceSink implements TraceSink {
  #chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async emit(event: TraceEvent): Promise<void> {
    const next = this.#chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`);
    });
    this.#chain = next.catch(() => {});
    await next;
  }
}

export class Trace {
  constructor(readonly traceId: string, private readonly sink: TraceSink) {}

  async event(name: string, attributes?: Record<string, unknown>, parentSpanId?: string): Promise<void> {
    await this.sink.emit({
      traceId: this.traceId,
      spanId: `${name}-${randomUUID()}`,
      parentSpanId,
      name,
      phase: "event",
      at: Date.now(),
      attributes,
    });
  }

  async span<T>(name: string, run: (spanId: string) => Promise<T>, attributes?: Record<string, unknown>, parentSpanId?: string): Promise<T> {
    const spanId = `${name}-${randomUUID()}`;
    const started = Date.now();
    await this.sink.emit({ traceId: this.traceId, spanId, parentSpanId, name, phase: "start", at: started, attributes });
    try {
      const value = await run(spanId);
      await this.sink.emit({ traceId: this.traceId, spanId, parentSpanId, name, phase: "end", at: Date.now(), attributes: { durationMs: Date.now() - started } });
      return value;
    } catch (error) {
      await this.sink.emit({
        traceId: this.traceId,
        spanId,
        parentSpanId,
        name,
        phase: "error",
        at: Date.now(),
        attributes: { durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }
}
