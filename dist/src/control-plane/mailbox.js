export class InMemoryMailboxStore {
    #messages = new Map();
    #cursors = new Map();
    async appendMailbox(agentId, message) {
        const items = this.#messages.get(agentId) ?? [];
        const existing = items.find((item) => item.message.id === message.id);
        if (existing)
            return { envelope: structuredClone(existing), inserted: false };
        const envelope = {
            agentId,
            seq: (items.at(-1)?.seq ?? 0) + 1,
            message: structuredClone(message),
            appendedAt: Date.now(),
        };
        items.push(envelope);
        this.#messages.set(agentId, items);
        return { envelope: structuredClone(envelope), inserted: true };
    }
    async readMailbox(agentId, afterSeq, limit = 1000) {
        return (this.#messages.get(agentId) ?? []).filter((item) => item.seq > afterSeq).slice(0, Math.max(0, limit)).map((item) => structuredClone(item));
    }
    async getMailboxCursor(agentId, consumerId) {
        const cursor = this.#cursors.get(cursorKey(agentId, consumerId));
        return cursor ? structuredClone(cursor) : undefined;
    }
    async ackMailbox(agentId, consumerId, throughSeq) {
        const key = cursorKey(agentId, consumerId);
        const existing = this.#cursors.get(key);
        const maxSeq = this.#messages.get(agentId)?.at(-1)?.seq ?? 0;
        const cursor = {
            agentId,
            consumerId,
            ackSeq: Math.max(existing?.ackSeq ?? 0, Math.min(throughSeq, maxSeq)),
            updatedAt: Date.now(),
        };
        this.#cursors.set(key, cursor);
        return structuredClone(cursor);
    }
}
function cursorKey(agentId, consumerId) { return `${agentId}\u0000${consumerId}`; }
