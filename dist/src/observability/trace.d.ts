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
export declare class InMemoryTraceSink implements TraceSink {
    readonly events: TraceEvent[];
    emit(event: TraceEvent): void;
}
export declare class JsonlTraceSink implements TraceSink {
    #private;
    private readonly path;
    constructor(path: string);
    emit(event: TraceEvent): Promise<void>;
}
export declare class Trace {
    readonly traceId: string;
    private readonly sink;
    constructor(traceId: string, sink: TraceSink);
    event(name: string, attributes?: Record<string, unknown>, parentSpanId?: string): Promise<void>;
    span<T>(name: string, run: (spanId: string) => Promise<T>, attributes?: Record<string, unknown>, parentSpanId?: string): Promise<T>;
}
