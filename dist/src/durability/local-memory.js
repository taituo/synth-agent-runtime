export class LocalMemoryDurability {
    #agents = new Map();
    #agentFences = new Map();
    #tasks = new Map();
    #relations = [];
    #events = [];
    #eventCursors = new Map();
    #nextSeq = 1;
    async createAgent(snapshot) {
        if (this.#agents.has(snapshot.id))
            return false;
        this.#agents.set(snapshot.id, structuredClone(snapshot));
        return true;
    }
    async putAgent(snapshot) {
        // LocalMemoryDurability is a single-writer provider. Keep unfenced writes
        // available for local mode while retaining the highest fenced generation
        // so explicit stale fenced writes are still rejected deterministically.
        this.#agents.set(snapshot.id, structuredClone(snapshot));
    }
    async putAgentFenced(snapshot, fence) {
        const current = this.#agentFences.get(snapshot.id) ?? 0;
        if (fence.fencingToken < current)
            return false;
        this.#agentFences.set(snapshot.id, fence.fencingToken);
        this.#agents.set(snapshot.id, structuredClone(snapshot));
        return true;
    }
    async getAgent(id) { const v = this.#agents.get(id); return v ? structuredClone(v) : undefined; }
    async listAgents() { return [...this.#agents.values()].map((v) => structuredClone(v)); }
    async putTask(task) { this.#tasks.set(task.id, structuredClone(task)); }
    async getTask(id) { const v = this.#tasks.get(id); return v ? structuredClone(v) : undefined; }
    async putRelation(relation) { this.#relations.push(structuredClone(relation)); }
    async listRelations() { return this.#relations.map((v) => structuredClone(v)); }
    async appendEvent(event) { this.#events.push({ seq: this.#nextSeq++, event: structuredClone(event) }); }
    async listEvents() { return this.#events.map((v) => structuredClone(v.event)); }
    async readEvents(options = {}) {
        const after = options.afterSeq ?? 0;
        const limit = Math.max(0, options.limit ?? 1000);
        return this.#events.filter((v) => v.seq > after).slice(0, limit).map((v) => structuredClone(v));
    }
    async pruneEvents(throughSeq) {
        const before = this.#events.length;
        this.#events = this.#events.filter((v) => v.seq > throughSeq);
        return before - this.#events.length;
    }
    async ackEvent(consumerId, throughSeq) {
        const maxSeq = this.#events.at(-1)?.seq ?? 0;
        const existing = this.#eventCursors.get(consumerId);
        const ackSeq = Math.max(existing?.ackSeq ?? 0, Math.min(throughSeq, maxSeq));
        const cursor = { consumerId, ackSeq, updatedAt: Date.now() };
        this.#eventCursors.set(consumerId, cursor);
        return structuredClone(cursor);
    }
    async getEventCursor(consumerId) {
        const value = this.#eventCursors.get(consumerId);
        return value ? structuredClone(value) : undefined;
    }
    async listEventCursors() {
        return [...this.#eventCursors.values()].map((value) => structuredClone(value));
    }
    async forgetEventConsumer(consumerId) {
        return this.#eventCursors.delete(consumerId);
    }
    async safeEventWatermark() {
        if (this.#eventCursors.size === 0)
            return 0;
        let min = Number.POSITIVE_INFINITY;
        for (const cursor of this.#eventCursors.values())
            min = Math.min(min, cursor.ackSeq);
        return min;
    }
    async pruneEventsSafe() {
        const watermark = await this.safeEventWatermark();
        return watermark <= 0 ? 0 : this.pruneEvents(watermark);
    }
}
