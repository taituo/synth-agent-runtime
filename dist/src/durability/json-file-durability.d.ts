import type { AgentId, TaskId } from "../core/ids.js";
import type { AgentSnapshot, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import type { AgentWriteFence, DurabilityProvider, EventReadOptions, SequencedRuntimeEvent } from "./types.js";
/** Crash-safe local DurabilityProvider for one control-plane writer. */
export declare class JsonFileDurabilityProvider implements DurabilityProvider {
    #private;
    readonly path: string;
    constructor(path: string);
    createAgent(snapshot: AgentSnapshot): Promise<boolean>;
    putAgent(snapshot: AgentSnapshot): Promise<void>;
    putAgentFenced(snapshot: AgentSnapshot, fence: AgentWriteFence): Promise<boolean>;
    getAgent(id: AgentId): Promise<AgentSnapshot | undefined>;
    listAgents(): Promise<AgentSnapshot[]>;
    putTask(task: TaskSpec): Promise<void>;
    getTask(id: TaskId): Promise<TaskSpec | undefined>;
    putRelation(relation: Relation): Promise<void>;
    listRelations(): Promise<Relation[]>;
    appendEvent(event: RuntimeEvent): Promise<void>;
    listEvents(): Promise<RuntimeEvent[]>;
    readEvents(options?: EventReadOptions): Promise<SequencedRuntimeEvent[]>;
    pruneEvents(throughSeq: number): Promise<number>;
}
