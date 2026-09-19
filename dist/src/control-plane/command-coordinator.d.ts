import type { RuntimeStateStore, DurableCommandRecord } from "../durability/runtime-state.js";
import type { LeaseStore } from "./lease.js";
export type CommandReconciliation<T> = {
    status: "committed";
    result: T;
} | {
    status: "retry";
} | {
    status: "failed";
    error: string;
} | {
    status: "unknown";
    detail?: string;
};
/**
 * Distributed command coordinator. A command lease serializes ownership and the
 * monotonic fencing token identifies the winning generation. An abandoned
 * `started` record is never replayed without explicit reconciliation.
 */
export declare class CommandCoordinator {
    private readonly state;
    private readonly leases;
    private readonly ownerId;
    private readonly ttlMs;
    constructor(state: RuntimeStateStore, leases: LeaseStore, ownerId: string, ttlMs?: number);
    run<T>(options: {
        id: string;
        run(signal: AbortSignal, fencingToken: number): Promise<T>;
        retrySafeOnError?: boolean;
        reconcile?(record: DurableCommandRecord): Promise<CommandReconciliation<T>>;
    }): Promise<T>;
}
