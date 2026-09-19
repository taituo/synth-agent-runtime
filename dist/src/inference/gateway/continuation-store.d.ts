export interface ContinuationRecord<T = unknown> {
    id: string;
    value: T;
    createdAt: number;
    expiresAt?: number;
    tenantId?: string;
}
export interface ContinuationStore<T = unknown> {
    putContinuation(record: ContinuationRecord<T>): Promise<void>;
    getContinuation(id: string, tenantId?: string): Promise<ContinuationRecord<T> | undefined>;
    deleteContinuation(id: string): Promise<void>;
    pruneContinuations(now?: number): Promise<number>;
}
export declare class InMemoryContinuationStore<T = unknown> implements ContinuationStore<T> {
    #private;
    private readonly maxEntries;
    constructor(maxEntries?: number);
    putContinuation(record: ContinuationRecord<T>): Promise<void>;
    getContinuation(id: string, tenantId?: string): Promise<ContinuationRecord<T> | undefined>;
    deleteContinuation(id: string): Promise<void>;
    pruneContinuations(now?: number): Promise<number>;
}
