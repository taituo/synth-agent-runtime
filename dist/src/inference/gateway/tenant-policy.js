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
export class CompositeTenantPolicy {
    policies;
    constructor(policies) {
        this.policies = policies;
    }
    async authorize(principal, model) {
        for (const policy of this.policies)
            await policy.authorize(principal, model);
    }
}
