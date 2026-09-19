import type { RuntimeStateStore } from "../durability/runtime-state.js";
import type { Effect, EffectContext, EffectResult, Executor } from "./types.js";
export declare class ExecutionBroker {
    #private;
    private readonly state?;
    constructor(executors: readonly Executor[], state?: RuntimeStateStore | undefined);
    /**
     * Executes one effect with effect.id as the idempotency key.
     *
     * A committed receipt is replayed. A `started` receipt is treated as an
     * uncertain external side effect after a crash and is not automatically
     * repeated. This favors duplicate prevention over blind retry.
     */
    execute(effect: Effect, context: EffectContext, minFidelity?: number): Promise<EffectResult>;
}
