export class InMemoryRouterStateStore {
    #health = new Map();
    #affinity = new Map();
    async getRouteHealth(routeKey) {
        const value = this.#health.get(routeKey);
        return value ? structuredClone(value) : undefined;
    }
    async putRouteHealth(health) { this.#health.set(health.routeKey, structuredClone(health)); }
    async getAffinity(key) {
        const value = this.#affinity.get(key);
        if (!value)
            return undefined;
        if (value.expiresAt !== undefined && value.expiresAt <= Date.now()) {
            this.#affinity.delete(key);
            return undefined;
        }
        return value.routeId;
    }
    async putAffinity(key, routeId, expiresAt) { this.#affinity.set(key, { routeId, expiresAt }); }
    async deleteAffinity(key) { this.#affinity.delete(key); }
}
