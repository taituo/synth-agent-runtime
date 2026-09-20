import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentId, TaskId } from "../core/ids.js";
import type { AgentSnapshot, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import type { AgentWriteFence, DurabilityProvider, EventCursor, EventReadOptions, SequencedRuntimeEvent } from "./types.js";

interface DurableFileState {
  agents: Record<string, AgentSnapshot>;
  agentFences: Record<string, number>;
  tasks: Record<string, TaskSpec>;
  relations: Relation[];
  events: SequencedRuntimeEvent[];
  eventCursors: Record<string, EventCursor>;
  nextEventSeq: number;
}

const EMPTY = (): DurableFileState => ({ agents: {}, agentFences: {}, tasks: {}, relations: [], events: [], eventCursors: {}, nextEventSeq: 1 });

/** Crash-safe local DurabilityProvider for one control-plane writer. */
export class JsonFileDurabilityProvider implements DurabilityProvider {
  #chain: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}

  async createAgent(snapshot: AgentSnapshot): Promise<boolean> {
    let created = false;
    await this.#mutate((state) => {
      if (state.agents[snapshot.id]) return;
      state.agents[snapshot.id] = structuredClone(snapshot);
      created = true;
    });
    return created;
  }

  async putAgent(snapshot: AgentSnapshot): Promise<void> {
    // This provider is explicitly single-writer. Unfenced local writes remain
    // supported, while explicit fenced writes still observe monotonic tokens.
    await this.#mutate((state) => { state.agents[snapshot.id] = structuredClone(snapshot); });
  }

  async putAgentFenced(snapshot: AgentSnapshot, fence: AgentWriteFence): Promise<boolean> {
    let accepted = false;
    await this.#mutate((state) => {
      const current = state.agentFences[snapshot.id] ?? 0;
      if (fence.fencingToken < current) return;
      state.agentFences[snapshot.id] = fence.fencingToken;
      state.agents[snapshot.id] = structuredClone(snapshot);
      accepted = true;
    });
    return accepted;
  }

  async getAgent(id: AgentId): Promise<AgentSnapshot | undefined> { const value = (await this.#read()).agents[id]; return value ? structuredClone(value) : undefined; }
  async listAgents(): Promise<AgentSnapshot[]> { return Object.values((await this.#read()).agents).sort((a, b) => String(a.id).localeCompare(String(b.id))).map((value) => structuredClone(value)); }
  async putTask(task: TaskSpec): Promise<void> { await this.#mutate((state) => { state.tasks[task.id] = structuredClone(task); }); }
  async getTask(id: TaskId): Promise<TaskSpec | undefined> { const value = (await this.#read()).tasks[id]; return value ? structuredClone(value) : undefined; }
  async putRelation(relation: Relation): Promise<void> {
    await this.#mutate((state) => { const key = relationKey(relation); const index = state.relations.findIndex((candidate) => relationKey(candidate) === key); if (index === -1) state.relations.push(structuredClone(relation)); else state.relations[index] = structuredClone(relation); });
  }
  async listRelations(): Promise<Relation[]> { return (await this.#read()).relations.map((value) => structuredClone(value)); }
  async appendEvent(event: RuntimeEvent): Promise<void> { await this.#mutate((state) => { state.events.push({ seq: state.nextEventSeq++, event: structuredClone(event) }); }); }
  async listEvents(): Promise<RuntimeEvent[]> { return (await this.#read()).events.map((value) => structuredClone(value.event)); }
  async readEvents(options: EventReadOptions = {}): Promise<SequencedRuntimeEvent[]> {
    const after = options.afterSeq ?? 0; const limit = Math.max(0, options.limit ?? 1000);
    return (await this.#read()).events.filter((value) => value.seq > after).slice(0, limit).map((value) => structuredClone(value));
  }
  async pruneEvents(throughSeq: number): Promise<number> {
    let removed = 0; await this.#mutate((state) => { const before = state.events.length; state.events = state.events.filter((value) => value.seq > throughSeq); removed = before - state.events.length; }); return removed;
  }
  async ackEvent(consumerId: string, throughSeq: number): Promise<EventCursor> {
    let cursor: EventCursor | undefined;
    await this.#mutate((state) => {
      const maxSeq = state.events.at(-1)?.seq ?? 0;
      const ackSeq = Math.max(state.eventCursors[consumerId]?.ackSeq ?? 0, Math.min(throughSeq, maxSeq));
      cursor = { consumerId, ackSeq, updatedAt: Date.now() };
      state.eventCursors[consumerId] = cursor;
    });
    return structuredClone(cursor!);
  }
  async getEventCursor(consumerId: string): Promise<EventCursor | undefined> {
    const value = (await this.#read()).eventCursors[consumerId];
    return value ? structuredClone(value) : undefined;
  }
  async listEventCursors(): Promise<EventCursor[]> {
    return Object.values((await this.#read()).eventCursors).map((value) => structuredClone(value));
  }
  async forgetEventConsumer(consumerId: string): Promise<boolean> {
    let removed = false;
    await this.#mutate((state) => { if (state.eventCursors[consumerId]) { delete state.eventCursors[consumerId]; removed = true; } });
    return removed;
  }
  async safeEventWatermark(): Promise<number> {
    const cursors = Object.values((await this.#read()).eventCursors);
    if (cursors.length === 0) return 0;
    return cursors.reduce((min, cursor) => Math.min(min, cursor.ackSeq), Number.POSITIVE_INFINITY);
  }
  async pruneEventsSafe(): Promise<number> {
    const watermark = await this.safeEventWatermark();
    return watermark <= 0 ? 0 : this.pruneEvents(watermark);
  }

  async #read(): Promise<DurableFileState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<DurableFileState> & { events?: Array<SequencedRuntimeEvent | RuntimeEvent> };
      const rawEvents = parsed.events ?? [];
      const sequenced: SequencedRuntimeEvent[] = rawEvents.map((value, index) => {
        if (value && typeof value === "object" && "seq" in value && "event" in value) return value as SequencedRuntimeEvent;
        return { seq: index + 1, event: value as RuntimeEvent };
      });
      return {
        agents: parsed.agents ?? {},
        agentFences: parsed.agentFences ?? {},
        tasks: parsed.tasks ?? {},
        relations: parsed.relations ?? [],
        events: sequenced,
        eventCursors: parsed.eventCursors ?? {},
        nextEventSeq: parsed.nextEventSeq ?? ((sequenced.at(-1)?.seq ?? 0) + 1),
      };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY(); throw error; }
  }

  async #mutate(update: (state: DurableFileState) => void): Promise<void> {
    const next = this.#chain.then(async () => { const state = await this.#read(); update(state); await mkdir(dirname(this.path), { recursive: true }); const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`; await writeFile(tmp, JSON.stringify(state, null, 2)); await rename(tmp, this.path); });
    this.#chain = next.catch(() => undefined); await next;
  }
}
function relationKey(relation: Relation): string { return `${relation.from}\u0000${relation.to}\u0000${relation.kind}`; }
