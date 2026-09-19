import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canReplaceCommand, canReplaceEffect, } from "./runtime-state.js";
const EMPTY = () => ({ commands: {}, workspaces: {}, turns: {}, effects: {} });
/**
 * Small crash-safe runtime state store for a single control-plane process.
 * Writes are serialized and use temp-file + rename. For multi-writer production
 * deployments replace this with a transactional database implementation.
 */
export class JsonFileRuntimeStateStore {
    path;
    #chain = Promise.resolve();
    constructor(path) {
        this.path = path;
    }
    async putCommand(record) {
        await this.#mutate((state) => { if (canReplaceCommand(state.commands[record.id], record))
            state.commands[record.id] = structuredClone(record); });
    }
    async getCommand(id) {
        const value = (await this.#read()).commands[id];
        return value ? structuredClone(value) : undefined;
    }
    async putWorkspaceCheckpoint(checkpoint) {
        await this.#mutate((state) => { state.workspaces[checkpoint.workspaceId] = structuredClone(checkpoint); });
    }
    async getWorkspaceCheckpoint(workspaceId) {
        const value = (await this.#read()).workspaces[workspaceId];
        return value ? structuredClone(value) : undefined;
    }
    async putTurn(record) {
        await this.#mutate((state) => { state.turns[record.id] = structuredClone(record); });
    }
    async getTurn(id) {
        const value = (await this.#read()).turns[id];
        return value ? structuredClone(value) : undefined;
    }
    async listTurns(status) {
        return Object.values((await this.#read()).turns)
            .filter((record) => status === undefined || record.status === status)
            .map((record) => structuredClone(record));
    }
    async putEffect(record) {
        await this.#mutate((state) => {
            if (canReplaceEffect(state.effects[record.id], record))
                state.effects[record.id] = structuredClone(record);
        });
    }
    async getEffect(id) {
        const value = (await this.#read()).effects[id];
        return value ? structuredClone(value) : undefined;
    }
    async #read() {
        try {
            const text = await readFile(this.path, "utf8");
            const parsed = JSON.parse(text);
            return { commands: parsed.commands ?? {}, workspaces: parsed.workspaces ?? {}, turns: parsed.turns ?? {}, effects: parsed.effects ?? {} };
        }
        catch (error) {
            if (error.code === "ENOENT")
                return EMPTY();
            throw error;
        }
    }
    async #mutate(update) {
        const next = this.#chain.then(async () => {
            const state = await this.#read();
            update(state);
            await mkdir(dirname(this.path), { recursive: true });
            const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
            await writeFile(tmp, JSON.stringify(state, null, 2));
            await rename(tmp, this.path);
        });
        this.#chain = next.catch(() => { });
        await next;
    }
}
