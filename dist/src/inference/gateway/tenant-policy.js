export class StaticBearerAuthenticator {
    #tokens;
    constructor(tokens) {
        this.#tokens = tokens instanceof Map ? tokens : new Map(Object.entries(tokens));
    }
    authenticate(request) {
        const header = request.headers.get("authorization");
        if (!header?.toLowerCase().startsWith("bearer "))
            return undefined;
        const principal = this.#tokens.get(header.slice(7));
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
