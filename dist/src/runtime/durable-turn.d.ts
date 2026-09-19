import type { AgentId } from "../core/ids.js";
import type { RuntimeStateStore } from "../durability/runtime-state.js";
import type { Effect, EffectResult } from "../execution/types.js";
import { MemoryWorkspace } from "../workspace/memory-workspace.js";
export type TurnToolPhase = "start" | "end";
export type EffectReplayMode = "attempt-local" | "commit" | "barrier";
export interface BufferedToolEvent {
    name: string;
    phase: TurnToolPhase;
    data?: unknown;
}
export interface DurableTurnOptions {
    workspace: MemoryWorkspace;
    attemptId: string;
    agentId?: AgentId;
    store?: RuntimeStateStore;
    turnId?: string;
    publishOutput?: (text: string) => void | Promise<void>;
    publishTool?: (event: BufferedToolEvent) => void | Promise<void>;
    executeEffect?: (effect: Effect) => Promise<EffectResult>;
    classifyEffect?: (effect: Effect) => EffectReplayMode;
}
/**
 * Transaction boundary around one model/agent attempt.
 *
 * Output/tool events are buffered until commit. Workspace changes are restored on
 * rollback. Irreversible effects should be classified as `commit` (deferred) or
 * `barrier` (execute now and make the attempt non-retryable).
 */
export declare class DurableTurn {
    #private;
    readonly id: string;
    private constructor();
    static begin(options: DurableTurnOptions): Promise<DurableTurn>;
    emitOutput(text: string): void;
    emitTool(name: string, phase: TurnToolPhase, data?: unknown): void;
    /** Explicitly marks that behavior escaped the transaction boundary. */
    markSemanticExposure(): void;
    get canRetry(): boolean;
    get closed(): boolean;
    get bufferedOutputCount(): number;
    stageEffect(effect: Effect): void;
    executeEffect(effect: Effect): Promise<EffectResult>;
    commit(): Promise<void>;
    rollback(error?: unknown): Promise<void>;
    fail(error: unknown): Promise<void>;
}
export interface DurableTurnAttempt<T> {
    id: string;
    run(turn: DurableTurn): Promise<T>;
    retryable(error: unknown, turn: DurableTurn): boolean;
}
export declare function runDurableTransactionalTurn<T>(options: Omit<DurableTurnOptions, "attemptId"> & {
    attempts: readonly DurableTurnAttempt<T>[];
    onAttempt?: (event: {
        type: "start" | "rollback" | "commit" | "failed";
        attemptId: string;
        turnId: string;
        error?: string;
    }) => void;
}): Promise<T>;
export declare function defaultEffectReplayMode(effect: Effect): EffectReplayMode;
