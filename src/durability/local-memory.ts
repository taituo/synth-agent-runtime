import type { AgentId, TaskId } from "../core/ids.js";
import type { AgentSnapshot, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import type { AgentWriteFence, DurabilityProvider, EventReadOptions, SequencedRuntimeEvent } from "./types.js";

export class LocalMemoryDurability implements DurabilityProvider {
  #agents = new Map<AgentId, AgentSnapshot>();
  #agentFences = new Map<AgentId, number>();
  #tasks = new Map<TaskId, TaskSpec>();
  #relations: Relation[] = [];
  #events: SequencedRuntimeEvent[] = [];
  #nextSeq = 1;

  async createAgent(snapshot: AgentSnapshot): Promise<boolean> {
    if (this.#agents.has(snapshot.id)) return false;
    this.#agents.set(snapshot.id, structuredClone(snapshot));
    return true;
  }

  async putAgent(snapshot: AgentSnapshot): Promise<void> {
    // LocalMemoryDurability is a single-writer provider. Keep unfenced writes
    // available for local mode while retaining the highest fenced generation
    // so explicit stale fenced writes are still rejected deterministically.
    this.#agents.set(snapshot.id, structuredClone(snapshot));
  }

  async putAgentFenced(snapshot: AgentSnapshot, fence: AgentWriteFence): Promise<boolean> {
    const current = this.#agentFences.get(snapshot.id) ?? 0;
    if (fence.fencingToken < current) return false;
    this.#agentFences.set(snapshot.id, fence.fencingToken);
    this.#agents.set(snapshot.id, structuredClone(snapshot));
    return true;
  }

  async getAgent(id: AgentId): Promise<AgentSnapshot | undefined> { const v = this.#agents.get(id); return v ? structuredClone(v) : undefined; }
  async listAgents(): Promise<AgentSnapshot[]> { return [...this.#agents.values()].map((v) => structuredClone(v)); }
  async putTask(task: TaskSpec): Promise<void> { this.#tasks.set(task.id, structuredClone(task)); }
  async getTask(id: TaskId): Promise<TaskSpec | undefined> { const v = this.#tasks.get(id); return v ? structuredClone(v) : undefined; }
  async putRelation(relation: Relation): Promise<void> { this.#relations.push(structuredClone(relation)); }
  async listRelations(): Promise<Relation[]> { return this.#relations.map((v) => structuredClone(v)); }
  async appendEvent(event: RuntimeEvent): Promise<void> { this.#events.push({ seq: this.#nextSeq++, event: structuredClone(event) }); }
  async listEvents(): Promise<RuntimeEvent[]> { return this.#events.map((v) => structuredClone(v.event)); }
  async readEvents(options: EventReadOptions = {}): Promise<SequencedRuntimeEvent[]> {
    const after = options.afterSeq ?? 0; const limit = Math.max(0, options.limit ?? 1000);
    return this.#events.filter((v) => v.seq > after).slice(0, limit).map((v) => structuredClone(v));
  }
  async pruneEvents(throughSeq: number): Promise<number> {
    const before = this.#events.length; this.#events = this.#events.filter((v) => v.seq > throughSeq); return before - this.#events.length;
  }
}
