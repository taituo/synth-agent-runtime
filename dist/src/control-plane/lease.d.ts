export interface LeaseRecord {
    resourceId: string;
    ownerId: string;
    fencingToken: number;
    acquiredAt: number;
    updatedAt: number;
    expiresAt: number;
}
export interface LeaseClaimResult {
    acquired: boolean;
    lease: LeaseRecord;
}
export interface LeaseStore {
    acquireLease(resourceId: string, ownerId: string, ttlMs: number, now?: number): Promise<LeaseClaimResult>;
    renewLease(resourceId: string, ownerId: string, fencingToken: number, ttlMs: number, now?: number): Promise<LeaseRecord | undefined>;
    releaseLease(resourceId: string, ownerId: string, fencingToken: number): Promise<boolean>;
    getLease(resourceId: string): Promise<LeaseRecord | undefined>;
    /**
     * Authoritative lease validation. Distributed stores should evaluate expiry
     * with the datastore clock rather than a worker-local clock.
     */
    validateLease(resourceId: string, ownerId: string, fencingToken: number, now?: number): Promise<LeaseRecord | undefined>;
}
/** Deterministic single-process lease store used by tests/local mode. */
export declare class InMemoryLeaseStore implements LeaseStore {
    #private;
    private readonly clock;
    constructor(clock?: () => number);
    acquireLease(resourceId: string, ownerId: string, ttlMs: number, now?: number): Promise<LeaseClaimResult>;
    renewLease(resourceId: string, ownerId: string, fencingToken: number, ttlMs: number, now?: number): Promise<LeaseRecord | undefined>;
    releaseLease(resourceId: string, ownerId: string, fencingToken: number): Promise<boolean>;
    getLease(resourceId: string): Promise<LeaseRecord | undefined>;
    validateLease(resourceId: string, ownerId: string, fencingToken: number, now?: number): Promise<LeaseRecord | undefined>;
}
/**
 * Runs work while holding a renewable fencing lease. Loss of the lease aborts
 * the supplied signal; callers must propagate that signal to external work.
 */
export declare function withRenewingLease<T>(options: {
    store: LeaseStore;
    resourceId: string;
    ownerId: string;
    ttlMs: number;
    renewEveryMs?: number;
    run(lease: LeaseRecord, signal: AbortSignal): Promise<T>;
}): Promise<T>;
