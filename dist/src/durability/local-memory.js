export class LocalMemoryDurability {
    #agents = new Map();
    #agentFences = new Map();
    #tasks = new Map();
    #relations = [];
    #events = [];
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
}
