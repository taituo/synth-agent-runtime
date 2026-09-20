export interface GatewayPrincipal {
    tenantId: string;
    subject: string;
    allowedModels?: readonly string[];
    requestsPerMinute?: number;
    /** Priority lane for this principal (see lane-scheduler.ts). Defaults to the lowest band. */
    lane?: string;
}
export interface GatewayAuthenticator {
    authenticate(request: Request): Promise<GatewayPrincipal | undefined> | GatewayPrincipal | undefined;
}
export interface GatewayTenantPolicy {
    authorize(principal: GatewayPrincipal, model: string): Promise<void> | void;
    /**
     * Optional: called once a request that was authorized has finished, so a
     * policy that admitted it can free the slot and admit the next queued
     * request (see PriorityLanePolicy).
     */
    release?(principal: GatewayPrincipal): Promise<void> | void;
}
export declare class StaticBearerAuthenticator implements GatewayAuthenticator {
    #private;
    constructor(tokens: ReadonlyMap<string, GatewayPrincipal> | Record<string, GatewayPrincipal>);
    authenticate(request: Request): GatewayPrincipal | undefined;
}
export declare class ModelAclPolicy implements GatewayTenantPolicy {
    authorize(principal: GatewayPrincipal, model: string): void;
}
export declare class InMemoryTenantRateLimitPolicy implements GatewayTenantPolicy {
    #private;
    private readonly now;
    constructor(now?: () => number);
    authorize(principal: GatewayPrincipal, _model: string): void;
}
/**
 * Shared counter backing for tenant rate limiting. Implementations must make
 * `increment` atomic across replicas (e.g. a single-row upsert), so the
 * effective limit does not multiply by the number of gateway processes.
 */
export interface SharedRateLimitStore {
    /** Atomically increment and return the count for (tenant, fixed window). */
    increment(tenantId: string, windowStartMs: number): Promise<number>;
    /** Optional: remove windows older than `beforeMs`. Returns rows removed. */
    prune?(beforeMs: number): Promise<number>;
}
/** Single-process implementation, for local mode and tests. */
export declare class InMemorySharedRateLimitStore implements SharedRateLimitStore {
    #private;
    increment(tenantId: string, windowStartMs: number): Promise<number>;
    prune(beforeMs: number): Promise<number>;
}
/**
 * Tenant rate limiting against a shared counter. Unlike
 * {@link InMemoryTenantRateLimitPolicy}, which keeps its window per process
 * (so N replicas allow up to N× the configured limit), every replica here
 * increments the same store, so the configured limit is global.
 */
export declare class SharedTenantRateLimitPolicy implements GatewayTenantPolicy {
    private readonly store;
    private readonly windowMs;
    private readonly now;
    constructor(store: SharedRateLimitStore, windowMs?: number, now?: () => number);
    authorize(principal: GatewayPrincipal): Promise<void>;
}
export declare class CompositeTenantPolicy implements GatewayTenantPolicy {
    private readonly policies;
    constructor(policies: readonly GatewayTenantPolicy[]);
    authorize(principal: GatewayPrincipal, model: string): Promise<void>;
    /** Forward to every sub-policy so a composed lane policy frees its slot. */
    release(principal: GatewayPrincipal): Promise<void>;
}
