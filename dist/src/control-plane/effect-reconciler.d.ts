import type { RuntimeStateStore, DurableEffectRecord } from "../durability/runtime-state.js";
import type { Effect, EffectContext, EffectResult } from "../execution/types.js";
export type ReconciliationOutcome = {
    status: "committed";
    result: EffectResult;
} | {
    status: "failed";
    result?: EffectResult;
    error: string;
} | {
    status: "pending";
    detail?: string;
} | {
    status: "unknown";
    detail?: string;
};
export interface EffectReconciliationProbe {
    supports(effect: Effect): boolean;
    reconcile(effect: Effect, context: EffectContext, receipt: DurableEffectRecord): Promise<ReconciliationOutcome>;
}
/** Resolves `started`/uncertain receipts without blindly replaying effects. */
export declare class EffectReconciler {
    private readonly state;
    private readonly probes;
    constructor(state: RuntimeStateStore, probes: readonly EffectReconciliationProbe[]);
    reconcile(effect: Effect, context: EffectContext): Promise<ReconciliationOutcome>;
}
