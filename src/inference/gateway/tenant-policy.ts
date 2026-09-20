import { createHash, timingSafeEqual } from "node:crypto";

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
export class InMemorySharedRateLimitStore implements SharedRateLimitStore {
  readonly #counts = new Map<string, number>();
  async increment(tenantId: string, windowStartMs: number): Promise<number> {
    const key = `${tenantId}@${windowStartMs}`;
    const next = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, next);
    return next;
  }
  async prune(beforeMs: number): Promise<number> {
    let removed = 0;
    for (const key of [...this.#counts.keys()]) {
      const at = Number(key.slice(key.lastIndexOf("@") + 1));
      if (at < beforeMs) { this.#counts.delete(key); removed++; }
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
export class SharedTenantRateLimitPolicy implements GatewayTenantPolicy {
  constructor(
    private readonly store: SharedRateLimitStore,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  async authorize(principal: GatewayPrincipal): Promise<void> {
    const limit = principal.requestsPerMinute;
    if (!limit || limit <= 0) return;
    const windowStartMs = Math.floor(this.now() / this.windowMs) * this.windowMs;
    const count = await this.store.increment(principal.tenantId, windowStartMs);
    if (count > limit) throw new Error(`RATE_LIMITED:${principal.tenantId}`);
  }
}

export class CompositeTenantPolicy implements GatewayTenantPolicy {
  constructor(private readonly policies: readonly GatewayTenantPolicy[]) {}
  async authorize(principal: GatewayPrincipal, model: string): Promise<void> {
    for (const policy of this.policies) await policy.authorize(principal, model);
  }
}
