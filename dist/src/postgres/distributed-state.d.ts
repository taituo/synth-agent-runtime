import type { AgentId } from "../core/ids.js";
import type { AgentMessage } from "../core/types.js";
import type { ContinuationRecord, ContinuationStore } from "../inference/gateway/continuation-store.js";
import type { SharedRateLimitStore } from "../inference/gateway/tenant-policy.js";
import type { RouterStateStore, SharedRouteHealth } from "../inference/gateway/router-state.js";
import type { LeaseClaimResult, LeaseRecord, LeaseStore } from "../control-plane/lease.js";
import type { MailboxAppendResult, MailboxCursor, MailboxEnvelope, MailboxStore } from "../control-plane/mailbox.js";
import type { PgExecutor } from "./types.js";
/** Shared distributed-control-plane primitives backed by PostgreSQL. */
export declare class PostgresDistributedControlStore implements LeaseStore, MailboxStore, ContinuationStore, RouterStateStore {
    readonly db: PgExecutor;
    constructor(db: PgExecutor);
    acquireLease(resourceId: string, ownerId: string, ttlMs: number, _now?: number): Promise<LeaseClaimResult>;
    renewLease(resourceId: string, ownerId: string, fencingToken: number, ttlMs: number, _now?: number): Promise<LeaseRecord | undefined>;
    releaseLease(resourceId: string, ownerId: string, fencingToken: number): Promise<boolean>;
    getLease(resourceId: string): Promise<LeaseRecord | undefined>;
    validateLease(resourceId: string, ownerId: string, fencingToken: number, _now?: number): Promise<LeaseRecord | undefined>;
    appendMailbox(agentId: AgentId, message: AgentMessage): Promise<MailboxAppendResult>;
    readMailbox(agentId: AgentId, afterSeq: number, limit?: number): Promise<MailboxEnvelope[]>;
    getMailboxCursor(agentId: AgentId, consumerId: string): Promise<MailboxCursor | undefined>;
    ackMailbox(agentId: AgentId, consumerId: string, throughSeq: number): Promise<MailboxCursor>;
    putContinuation(record: ContinuationRecord): Promise<void>;
    getContinuation(id: string, tenantId?: string): Promise<ContinuationRecord | undefined>;
    deleteContinuation(id: string): Promise<void>;
    pruneContinuations(now?: number): Promise<number>;
    getRouteHealth(routeKey: string): Promise<SharedRouteHealth | undefined>;
    putRouteHealth(health: SharedRouteHealth): Promise<void>;
    getAffinity(key: string): Promise<string | undefined>;
    putAffinity(key: string, routeId: string, expiresAt?: number): Promise<void>;
    deleteAffinity(key: string): Promise<void>;
}
/**
 * Shared tenant rate-limit counter backed by PostgreSQL. The upsert is atomic,
 * so multiple gateway replicas increment the same per-(tenant, window) row and
 * a tenant's configured limit is global rather than per-process.
 */
export declare class PostgresRateLimitStore implements SharedRateLimitStore {
    readonly db: PgExecutor;
    constructor(db: PgExecutor);
    increment(tenantId: string, windowStartMs: number): Promise<number>;
    prune(beforeMs: number): Promise<number>;
}
