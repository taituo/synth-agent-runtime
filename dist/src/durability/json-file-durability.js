import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const EMPTY = () => ({ agents: {}, agentFences: {}, tasks: {}, relations: [], events: [], nextEventSeq: 1 });
/** Crash-safe local DurabilityProvider for one control-plane writer. */
export class JsonFileDurabilityProvider {
    path;
    #chain = Promise.resolve();
    constructor(path) {
        this.path = path;
    }
    async createAgent(snapshot) {
        let created = false;
        await this.#mutate((state) => {
            if (state.agents[snapshot.id])
                return;
            state.agents[snapshot.id] = structuredClone(snapshot);
            created = true;
        });
        return created;
    }
    async putAgent(snapshot) {
        // This provider is explicitly single-writer. Unfenced local writes remain
        // supported, while explicit fenced writes still observe monotonic tokens.
        await this.#mutate((state) => { state.agents[snapshot.id] = structuredClone(snapshot); });
    }
    async putAgentFenced(snapshot, fence) {
        let accepted = false;
        await this.#mutate((state) => {
            const current = state.agentFences[snapshot.id] ?? 0;
            if (fence.fencingToken < current)
                return;
            state.agentFences[snapshot.id] = fence.fencingToken;
            state.agents[snapshot.id] = structuredClone(snapshot);
            accepted = true;
        });
        return accepted;
    }
    async getAgent(id) { const value = (await this.#read()).agents[id]; return value ? structuredClone(value) : undefined; }
    async listAgents() { return Object.values((await this.#read()).agents).sort((a, b) => String(a.id).localeCompare(String(b.id))).map((value) => structuredClone(value)); }
    async putTask(task) { await this.#mutate((state) => { state.tasks[task.id] = structuredClone(task); }); }
    async getTask(id) { const value = (await this.#read()).tasks[id]; return value ? structuredClone(value) : undefined; }
    async putRelation(relation) {
        await this.#mutate((state) => { const key = relationKey(relation); const index = state.relations.findIndex((candidate) => relationKey(candidate) === key); if (index === -1)
            state.relations.push(structuredClone(relation));
        else
            state.relations[index] = structuredClone(relation); });
    }
    async listRelations() { return (await this.#read()).relations.map((value) => structuredClone(value)); }
    async appendEvent(event) { await this.#mutate((state) => { state.events.push({ seq: state.nextEventSeq++, event: structuredClone(event) }); }); }
    async listEvents() { return (await this.#read()).events.map((value) => structuredClone(value.event)); }
    async readEvents(options = {}) {
        const after = options.afterSeq ?? 0;
        const limit = Math.max(0, options.limit ?? 1000);
        return (await this.#read()).events.filter((value) => value.seq > after).slice(0, limit).map((value) => structuredClone(value));
    }
    async pruneEvents(throughSeq) {
        let removed = 0;
        await this.#mutate((state) => { const before = state.events.length; state.events = state.events.filter((value) => value.seq > throughSeq); removed = before - state.events.length; });
        return removed;
    }
    async #read() {
        try {
            const parsed = JSON.parse(await readFile(this.path, "utf8"));
            const rawEvents = parsed.events ?? [];
            const sequenced = rawEvents.map((value, index) => {
                if (value && typeof value === "object" && "seq" in value && "event" in value)
                    return value;
                return { seq: index + 1, event: value };
            });
            return {
                agents: parsed.agents ?? {},
                agentFences: parsed.agentFences ?? {},
                tasks: parsed.tasks ?? {},
                relations: parsed.relations ?? [],
                events: sequenced,
                nextEventSeq: parsed.nextEventSeq ?? ((sequenced.at(-1)?.seq ?? 0) + 1),
            };
        }
        catch (error) {
            if (error.code === "ENOENT")
                return EMPTY();
            throw error;
        }
    }
    async #mutate(update) {
        const next = this.#chain.then(async () => { const state = await this.#read(); update(state); await mkdir(dirname(this.path), { recursive: true }); const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`; await writeFile(tmp, JSON.stringify(state, null, 2)); await rename(tmp, this.path); });
        this.#chain = next.catch(() => undefined);
        await next;
    }
}
function relationKey(relation) { return `${relation.from}\u0000${relation.to}\u0000${relation.kind}`; }
