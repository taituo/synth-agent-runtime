import { createHash, timingSafeEqual } from "node:crypto";

export interface GatewayPrincipal {
  tenantId: string;
  subject: string;
  allowedModels?: readonly string[];
  requestsPerMinute?: number;
}

export interface GatewayAuthenticator {
  authenticate(request: Request): Promise<GatewayPrincipal | undefined> | GatewayPrincipal | undefined;
}

export interface GatewayTenantPolicy {
  authorize(principal: GatewayPrincipal, model: string): Promise<void> | void;
}

/** SHA-256 digest of a token, used for fixed-length constant-time comparison. */
function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class StaticBearerAuthenticator implements GatewayAuthenticator {
  readonly #tokens: ReadonlyArray<{ digest: Buffer; principal: GatewayPrincipal }>;
  constructor(tokens: ReadonlyMap<string, GatewayPrincipal> | Record<string, GatewayPrincipal>) {
    const entries = tokens instanceof Map ? [...tokens.entries()] : Object.entries(tokens);
    this.#tokens = entries.map(([token, principal]) => ({ digest: tokenDigest(token), principal }));
  }
  authenticate(request: Request): GatewayPrincipal | undefined {
    const header = request.headers.get("authorization");
    if (!header?.toLowerCase().startsWith("bearer ")) return undefined;
    // Compare SHA-256 digests with timingSafeEqual rather than a Map lookup so
    // comparison time does not depend on how many leading characters of the
    // presented token match a known one. Digesting first keeps both sides a
    // fixed 32 bytes, so a length mismatch neither leaks nor throws. The loop
    // has no early exit, so its cost is independent of which (or whether any)
    // token matched.
    const presented = tokenDigest(header.slice(7));
    let principal: GatewayPrincipal | undefined;
    for (const entry of this.#tokens) {
      if (timingSafeEqual(presented, entry.digest)) principal = entry.principal;
    }
    return principal ? structuredClone(principal) : undefined;
  }
}

export class ModelAclPolicy implements GatewayTenantPolicy {
  authorize(principal: GatewayPrincipal, model: string): void {
    if (principal.allowedModels && !principal.allowedModels.includes(model)) throw new Error(`MODEL_FORBIDDEN:${model}`);
  }
}

export class InMemoryTenantRateLimitPolicy implements GatewayTenantPolicy {
  readonly #windows = new Map<string, { minute: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  authorize(principal: GatewayPrincipal, _model: string): void {
    const limit = principal.requestsPerMinute;
    if (!limit || limit <= 0) return;
    const minute = Math.floor(this.now() / 60_000);
    const current = this.#windows.get(principal.tenantId);
    const window = current?.minute === minute ? current : { minute, count: 0 };
    window.count++;
    this.#windows.set(principal.tenantId, window);
    if (window.count > limit) throw new Error(`RATE_LIMITED:${principal.tenantId}`);
  }
}

export class CompositeTenantPolicy implements GatewayTenantPolicy {
  constructor(private readonly policies: readonly GatewayTenantPolicy[]) {}
  async authorize(principal: GatewayPrincipal, model: string): Promise<void> {
    for (const policy of this.policies) await policy.authorize(principal, model);
  }
}
