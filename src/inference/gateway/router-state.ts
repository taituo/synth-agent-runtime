export interface SharedRouteHealth {
  routeKey: string;
  cooldownUntil?: number;
  successes: number;
  failures: number;
  lastStatus?: number;
  updatedAt: number;
}

export interface RouterStateStore {
  getRouteHealth(routeKey: string): Promise<SharedRouteHealth | undefined>;
  putRouteHealth(health: SharedRouteHealth): Promise<void>;
  getAffinity(key: string): Promise<string | undefined>;
  putAffinity(key: string, routeId: string, expiresAt?: number): Promise<void>;
  deleteAffinity(key: string): Promise<void>;
}

export class InMemoryRouterStateStore implements RouterStateStore {
  readonly #health = new Map<string, SharedRouteHealth>();
  readonly #affinity = new Map<string, { routeId: string; expiresAt?: number }>();

  async getRouteHealth(routeKey: string): Promise<SharedRouteHealth | undefined> {
    const value = this.#health.get(routeKey); return value ? structuredClone(value) : undefined;
  }
  async putRouteHealth(health: SharedRouteHealth): Promise<void> { this.#health.set(health.routeKey, structuredClone(health)); }
  async getAffinity(key: string): Promise<string | undefined> {
    const value = this.#affinity.get(key);
    if (!value) return undefined;
    if (value.expiresAt !== undefined && value.expiresAt <= Date.now()) { this.#affinity.delete(key); return undefined; }
    return value.routeId;
  }
  async putAffinity(key: string, routeId: string, expiresAt?: number): Promise<void> { this.#affinity.set(key, { routeId, expiresAt }); }
  async deleteAffinity(key: string): Promise<void> { this.#affinity.delete(key); }
}
