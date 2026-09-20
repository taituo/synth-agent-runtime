import { createHash, timingSafeEqual } from "node:crypto";
/** SHA-256 digest of a token, used for fixed-length constant-time comparison. */
function tokenDigest(token) {
    return createHash("sha256").update(token, "utf8").digest();
}
export class StaticBearerAuthenticator {
    #tokens;
    constructor(tokens) {
        const entries = tokens instanceof Map ? [...tokens.entries()] : Object.entries(tokens);
        this.#tokens = entries.map(([token, principal]) => ({ digest: tokenDigest(token), principal }));
    }
    authenticate(request) {
        const header = request.headers.get("authorization");
        if (!header?.toLowerCase().startsWith("bearer "))
            return undefined;
        // Compare SHA-256 digests with timingSafeEqual rather than a Map lookup so
        // comparison time does not depend on how many leading characters of the
        // presented token match a known one. Digesting first keeps both sides a
        // fixed 32 bytes, so a length mismatch neither leaks nor throws. The loop
        // has no early exit, so its cost is independent of which (or whether any)
        // token matched.
        const presented = tokenDigest(header.slice(7));
        let principal;
        for (const entry of this.#tokens) {
            if (timingSafeEqual(presented, entry.digest))
                principal = entry.principal;
        }
        return principal ? structuredClone(principal) : undefined;
    }
}
export class ModelAclPolicy {
    authorize(principal, model) {
        if (principal.allowedModels && !principal.allowedModels.includes(model))
            throw new Error(`MODEL_FORBIDDEN:${model}`);
    }
}
export class InMemoryTenantRateLimitPolicy {
    now;
    #windows = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    authorize(principal, _model) {
        const limit = principal.requestsPerMinute;
        if (!limit || limit <= 0)
            return;
        const minute = Math.floor(this.now() / 60_000);
        const current = this.#windows.get(principal.tenantId);
        const window = current?.minute === minute ? current : { minute, count: 0 };
        window.count++;
        this.#windows.set(principal.tenantId, window);
        if (window.count > limit)
            throw new Error(`RATE_LIMITED:${principal.tenantId}`);
    }
}
/** Single-process implementation, for local mode and tests. */
export class InMemorySharedRateLimitStore {
    #counts = new Map();
    async increment(tenantId, windowStartMs) {
        const key = `${tenantId}@${windowStartMs}`;
        const next = (this.#counts.get(key) ?? 0) + 1;
        this.#counts.set(key, next);
        return next;
    }
    async prune(beforeMs) {
        let removed = 0;
        for (const key of [...this.#counts.keys()]) {
            const at = Number(key.slice(key.lastIndexOf("@") + 1));
            if (at < beforeMs) {
                this.#counts.delete(key);
                removed++;
            }
        }
        return removed;
    }
}
/**
 * Tenant rate limiting against a shared counter. Unlike
 * {@link InMemoryTenantRateLimitPolicy}, which keeps its window per process
 * (so N replicas allow up to N× the configured limit), every replica here
 * increments the same store, so the configured limit is global.
 */
export class SharedTenantRateLimitPolicy {
    store;
    windowMs;
    now;
    constructor(store, windowMs = 60_000, now = Date.now) {
        this.store = store;
        this.windowMs = windowMs;
        this.now = now;
    }
    async authorize(principal) {
        const limit = principal.requestsPerMinute;
        if (!limit || limit <= 0)
            return;
        const windowStartMs = Math.floor(this.now() / this.windowMs) * this.windowMs;
        const count = await this.store.increment(principal.tenantId, windowStartMs);
        if (count > limit)
            throw new Error(`RATE_LIMITED:${principal.tenantId}`);
    }
}
export class CompositeTenantPolicy {
    policies;
    constructor(policies) {
        this.policies = policies;
    }
    async authorize(principal, model) {
        const authorized = [];
        try {
            for (const policy of this.policies) {
                await policy.authorize(principal, model);
                authorized.push(policy);
            }
        }
        catch (error) {
            // A later policy failing must not leak an earlier policy's admission
            // (e.g. the lane slot taken by PriorityLanePolicy before the rate-limit
            // policy throws).
            for (const policy of authorized.reverse())
                await policy.release?.(principal);
            throw error;
        }
    }
    /** Forward to every sub-policy so a composed lane policy frees its slot. */
    async release(principal) {
        for (const policy of this.policies)
            await policy.release?.(principal);
    }
}
