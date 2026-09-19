import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
export class InMemoryTraceSink {
    events = [];
    emit(event) { this.events.push(structuredClone(event)); }
}
export class JsonlTraceSink {
    path;
    #chain = Promise.resolve();
    constructor(path) {
        this.path = path;
    }
    async emit(event) {
        const next = this.#chain.then(async () => {
            await mkdir(dirname(this.path), { recursive: true });
            await appendFile(this.path, `${JSON.stringify(event)}\n`);
        });
        this.#chain = next.catch(() => { });
        await next;
    }
}
export class Trace {
    traceId;
    sink;
    constructor(traceId, sink) {
        this.traceId = traceId;
        this.sink = sink;
    }
    async event(name, attributes, parentSpanId) {
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
    async span(name, run, attributes, parentSpanId) {
        const spanId = `${name}-${randomUUID()}`;
        const started = Date.now();
        await this.sink.emit({ traceId: this.traceId, spanId, parentSpanId, name, phase: "start", at: started, attributes });
        try {
            const value = await run(spanId);
            await this.sink.emit({ traceId: this.traceId, spanId, parentSpanId, name, phase: "end", at: Date.now(), attributes: { durationMs: Date.now() - started } });
            return value;
        }
        catch (error) {
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
