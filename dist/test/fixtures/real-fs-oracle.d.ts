import type { Effect, EffectContext, EffectResult, Executor } from "../../src/execution/types.js";
export declare class RealFsOracle implements Executor {
    private readonly root;
    readonly id = "real-fs-oracle";
    readonly fidelity = 100;
    constructor(root: string);
    canExecute(effect: Effect): boolean;
    execute(effect: Effect, _context: EffectContext): Promise<EffectResult>;
}
