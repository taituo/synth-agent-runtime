import type { MemoryWorkspace } from "../workspace/memory-workspace.js";
export interface TransactionalAttempt<T> {
    id: string;
    run(): Promise<T>;
    /** Retry only when the failed attempt has not exposed semantic output. */
    retryable(error: unknown): boolean;
}
export interface TransactionalTurnEvent {
    type: "attempt.start" | "attempt.rollback" | "attempt.commit" | "attempt.failed";
    attemptId: string;
    error?: string;
}
/**
 * Provider/agent-turn replay primitive. Each retry starts from the same synthetic
 * workspace state. Callers are responsible for declaring an attempt retryable
 * only before user-visible text/tool semantics have escaped.
 */
export declare function runTransactionalTurn<T>(options: {
    workspace: MemoryWorkspace;
    attempts: readonly TransactionalAttempt<T>[];
    onEvent?: (event: TransactionalTurnEvent) => void;
}): Promise<T>;
