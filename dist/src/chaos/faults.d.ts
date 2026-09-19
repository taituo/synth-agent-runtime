export interface FaultRule {
    /** Stable failpoint such as runtime.putAgent.before or executor.execute.after. */
    point: string;
    /** Fire on this matching hit (1-based). Default 1. */
    nth?: number;
    /** Fire on every hit at/after nth instead of once. */
    repeat?: boolean;
    message?: string;
}
export interface FaultHit {
    point: string;
    count: number;
    fired: boolean;
    at: number;
}
/** Deterministic failpoint engine for repeatable crash/failure tests. */
export declare class ChaosController {
    #private;
    constructor(rules?: readonly FaultRule[]);
    hit(point: string): void;
    history(): FaultHit[];
    count(point: string): number;
}
export declare class ChaosFault extends Error {
    readonly point: string;
    readonly hitCount: number;
    readonly code = "SYNTH_CHAOS_FAULT";
    constructor(point: string, hitCount: number, message: string);
}
