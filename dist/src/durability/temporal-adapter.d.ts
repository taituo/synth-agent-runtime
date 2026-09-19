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
export declare class TemporalDurabilityProvider implements DurabilityProvider {
    private readonly bindings;
    constructor(bindings: TemporalDurabilityBindings);
    createAgent(v: AgentSnapshot): Promise<boolean>;
    putAgent(v: AgentSnapshot): Promise<void>;
    getAgent(id: AgentId): Promise<AgentSnapshot | undefined>;
    listAgents(): Promise<AgentSnapshot[]>;
    putTask(v: TaskSpec): Promise<void>;
    getTask(id: TaskId): Promise<TaskSpec | undefined>;
    putRelation(v: Relation): Promise<void>;
    listRelations(): Promise<Relation[]>;
    appendEvent(v: RuntimeEvent): Promise<void>;
    listEvents(): Promise<RuntimeEvent[]>;
}
