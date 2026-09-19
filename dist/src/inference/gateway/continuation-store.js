export class InMemoryContinuationStore {
    maxEntries;
    #records = new Map();
    constructor(maxEntries = 1000) {
        this.maxEntries = maxEntries;
    }
    async putContinuation(record) {
        this.#records.delete(record.id);
        this.#records.set(record.id, structuredClone(record));
        while (this.#records.size > this.maxEntries) {
            const id = this.#records.keys().next().value;
            if (!id)
                break;
            this.#records.delete(id);
        }
    }
    async getContinuation(id, tenantId) {
        const record = this.#records.get(id);
        if (!record)
            return undefined;
        if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
            this.#records.delete(id);
            return undefined;
        }
        if ((tenantId ?? undefined) !== (record.tenantId ?? undefined))
            return undefined;
        return structuredClone(record);
    }
    async deleteContinuation(id) { this.#records.delete(id); }
    async pruneContinuations(now = Date.now()) {
        let deleted = 0;
        for (const [id, record] of this.#records) {
            if (record.expiresAt !== undefined && record.expiresAt <= now) {
                this.#records.delete(id);
                deleted++;
            }
        }
        return deleted;
    }
}
