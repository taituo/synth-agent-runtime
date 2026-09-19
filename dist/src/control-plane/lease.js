function copy(value) { return structuredClone(value); }
/** Deterministic single-process lease store used by tests/local mode. */
export class InMemoryLeaseStore {
    clock;
    #leases = new Map();
    #tokens = new Map();
    constructor(clock = Date.now) {
        this.clock = clock;
    }
    async acquireLease(resourceId, ownerId, ttlMs, now = this.clock()) {
        validateTtl(ttlMs);
        const existing = this.#leases.get(resourceId);
        if (existing && existing.expiresAt > now)
            return { acquired: false, lease: copy(existing) };
        const fencingToken = (this.#tokens.get(resourceId) ?? existing?.fencingToken ?? 0) + 1;
        this.#tokens.set(resourceId, fencingToken);
        const lease = { resourceId, ownerId, fencingToken, acquiredAt: now, updatedAt: now, expiresAt: now + ttlMs };
        this.#leases.set(resourceId, lease);
        return { acquired: true, lease: copy(lease) };
    }
    async renewLease(resourceId, ownerId, fencingToken, ttlMs, now = this.clock()) {
        validateTtl(ttlMs);
        const existing = this.#leases.get(resourceId);
        if (!existing || existing.ownerId !== ownerId || existing.fencingToken !== fencingToken || existing.expiresAt <= now)
            return undefined;
        const renewed = { ...existing, updatedAt: now, expiresAt: now + ttlMs };
        this.#leases.set(resourceId, renewed);
        return copy(renewed);
    }
    async releaseLease(resourceId, ownerId, fencingToken) {
        const existing = this.#leases.get(resourceId);
        if (!existing || existing.ownerId !== ownerId || existing.fencingToken !== fencingToken)
            return false;
        this.#leases.delete(resourceId);
        return true;
    }
    async getLease(resourceId) {
        const existing = this.#leases.get(resourceId);
        return existing ? copy(existing) : undefined;
    }
    async validateLease(resourceId, ownerId, fencingToken, now = this.clock()) {
        const existing = this.#leases.get(resourceId);
        if (!existing || existing.ownerId !== ownerId || existing.fencingToken !== fencingToken || existing.expiresAt <= now)
            return undefined;
        return copy(existing);
    }
}
/**
 * Runs work while holding a renewable fencing lease. Loss of the lease aborts
 * the supplied signal; callers must propagate that signal to external work.
 */
export async function withRenewingLease(options) {
    const claim = await options.store.acquireLease(options.resourceId, options.ownerId, options.ttlMs);
    if (!claim.acquired)
        throw new Error(`LEASE_HELD:${options.resourceId}:${claim.lease.ownerId}`);
    const controller = new AbortController();
    const intervalMs = Math.max(1, Math.min(options.renewEveryMs ?? Math.max(1, Math.floor(options.ttlMs / 3)), Math.max(1, Math.floor(options.ttlMs / 2))));
    let renewing = false;
    const timer = setInterval(() => {
        if (renewing || controller.signal.aborted)
            return;
        renewing = true;
        void options.store.renewLease(options.resourceId, options.ownerId, claim.lease.fencingToken, options.ttlMs)
            .then((renewed) => { if (!renewed)
            controller.abort(new Error(`LEASE_LOST:${options.resourceId}`)); })
            .catch((error) => controller.abort(error))
            .finally(() => { renewing = false; });
    }, intervalMs);
    timer.unref?.();
    try {
        return await options.run(claim.lease, controller.signal);
    }
    finally {
        clearInterval(timer);
        await options.store.releaseLease(options.resourceId, options.ownerId, claim.lease.fencingToken).catch(() => false);
    }
}
function validateTtl(ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
        throw new Error(`Invalid lease ttl: ${ttlMs}`);
}
