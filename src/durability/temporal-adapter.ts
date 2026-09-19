import type { AgentId, TaskId } from "../core/ids.js";
import type { AgentSnapshot, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import type { DurabilityProvider } from "./types.js";

/**
 * Deliberately does not import the Temporal SDK. The app supplies durable
 * operations, so the public agent runtime does not become Temporal-shaped.
 */
export interface TemporalDurabilityBindings {
  createAgent(snapshot: AgentSnapshot): Promise<boolean>;
  putAgent(snapshot: AgentSnapshot): Promise<void>;
  getAgent(id: AgentId): Promise<AgentSnapshot | undefined>;
  listAgents(): Promise<AgentSnapshot[]>;
  putTask(task: TaskSpec): Promise<void>;
  getTask(id: TaskId): Promise<TaskSpec | undefined>;
  putRelation(relation: Relation): Promise<void>;
  listRelations(): Promise<Relation[]>;
  appendEvent(event: RuntimeEvent): Promise<void>;
  listEvents(): Promise<RuntimeEvent[]>;
}

export class TemporalDurabilityProvider implements DurabilityProvider {
  constructor(private readonly bindings: TemporalDurabilityBindings) {}
  createAgent(v: AgentSnapshot) { return this.bindings.createAgent(v); }
  putAgent(v: AgentSnapshot) { return this.bindings.putAgent(v); }
  getAgent(id: AgentId) { return this.bindings.getAgent(id); }
  listAgents() { return this.bindings.listAgents(); }
  putTask(v: TaskSpec) { return this.bindings.putTask(v); }
  getTask(id: TaskId) { return this.bindings.getTask(id); }
  putRelation(v: Relation) { return this.bindings.putRelation(v); }
  listRelations() { return this.bindings.listRelations(); }
  appendEvent(v: RuntimeEvent) { return this.bindings.appendEvent(v); }
  listEvents() { return this.bindings.listEvents(); }
}
