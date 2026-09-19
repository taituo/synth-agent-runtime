import { canReplaceCommand, canReplaceEffect, } from "./runtime-state.js";
export class LocalRuntimeStateStore {
    #commands = new Map();
    #workspaces = new Map();
    #turns = new Map();
    #effects = new Map();
    async putCommand(record) {
        const existing = this.#commands.get(record.id);
        if (canReplaceCommand(existing, record))
            this.#commands.set(record.id, structuredClone(record));
    }
    async getCommand(id) {
        const value = this.#commands.get(id);
        return value ? structuredClone(value) : undefined;
    }
    async claimCommand(record) {
        const existing = this.#commands.get(record.id);
        if (existing?.status === "committed" || existing?.status === "started") {
            return { claimed: false, record: structuredClone(existing) };
        }
        this.#commands.set(record.id, structuredClone(record));
        return { claimed: true, record: structuredClone(record) };
    }
    async putWorkspaceCheckpoint(checkpoint) {
        this.#workspaces.set(checkpoint.workspaceId, structuredClone(checkpoint));
    }
    async getWorkspaceCheckpoint(workspaceId) {
        const value = this.#workspaces.get(workspaceId);
        return value ? structuredClone(value) : undefined;
    }
    async putTurn(record) {
        this.#turns.set(record.id, structuredClone(record));
    }
    async getTurn(id) {
        const value = this.#turns.get(id);
        return value ? structuredClone(value) : undefined;
    }
    async listTurns(status) {
        return [...this.#turns.values()]
            .filter((value) => status === undefined || value.status === status)
            .map((value) => structuredClone(value));
    }
    async putEffect(record) {
        const existing = this.#effects.get(record.id);
        if (canReplaceEffect(existing, record))
            this.#effects.set(record.id, structuredClone(record));
    }
    async getEffect(id) {
        const value = this.#effects.get(id);
        return value ? structuredClone(value) : undefined;
    }
    async claimEffect(record) {
        const existing = this.#effects.get(record.id);
        if (existing)
            return { claimed: false, record: structuredClone(existing) };
        this.#effects.set(record.id, structuredClone(record));
        return { claimed: true, record: structuredClone(record) };
    }
}
