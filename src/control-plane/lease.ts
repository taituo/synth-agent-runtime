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

function copy<T>(value: T): T { return structuredClone(value); }

/** Deterministic single-process lease store used by tests/local mode. */
export class InMemoryLeaseStore implements LeaseStore {
  readonly #leases = new Map<string, LeaseRecord>();
  readonly #tokens = new Map<string, number>();
  constructor(private readonly clock: () => number = Date.now) {}

  async acquireLease(resourceId: string, ownerId: string, ttlMs: number, now = this.clock()): Promise<LeaseClaimResult> {
    validateTtl(ttlMs);
    const existing = this.#leases.get(resourceId);
    if (existing && existing.expiresAt > now) return { acquired: false, lease: copy(existing) };
    const fencingToken = (this.#tokens.get(resourceId) ?? existing?.fencingToken ?? 0) + 1;
    this.#tokens.set(resourceId, fencingToken);
    const lease: LeaseRecord = { resourceId, ownerId, fencingToken, acquiredAt: now, updatedAt: now, expiresAt: now + ttlMs };
    this.#leases.set(resourceId, lease);
    return { acquired: true, lease: copy(lease) };
  }

  async renewLease(resourceId: string, ownerId: string, fencingToken: number, ttlMs: number, now = this.clock()): Promise<LeaseRecord | undefined> {
    validateTtl(ttlMs);
    const existing = this.#leases.get(resourceId);
    if (!existing || existing.ownerId !== ownerId || existing.fencingToken !== fencingToken || existing.expiresAt <= now) return undefined;
    const renewed = { ...existing, updatedAt: now, expiresAt: now + ttlMs };
    this.#leases.set(resourceId, renewed);
    return copy(renewed);
  }

  async releaseLease(resourceId: string, ownerId: string, fencingToken: number): Promise<boolean> {
    const existing = this.#leases.get(resourceId);
    if (!existing || existing.ownerId !== ownerId || existing.fencingToken !== fencingToken) return false;
    this.#leases.delete(resourceId);
    return true;
  }

  async getLease(resourceId: string): Promise<LeaseRecord | undefined> {
    const existing = this.#leases.get(resourceId);
    return existing ? copy(existing) : undefined;
  }

  async validateLease(resourceId: string, ownerId: string, fencingToken: number, now = this.clock()): Promise<LeaseRecord | undefined> {
    const existing = this.#leases.get(resourceId);
    if (!existing || existing.ownerId !== ownerId || existing.fencingToken !== fencingToken || existing.expiresAt <= now) return undefined;
    return copy(existing);
  }
}

function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`Invalid lease ttl: ${ttlMs}`);
}
