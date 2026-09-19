import type { AgentId, TaskId } from "../core/ids.js";
import type { AgentSnapshot, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";

export interface SequencedRuntimeEvent {
  seq: number;
  event: RuntimeEvent;
}

export interface EventReadOptions {
  afterSeq?: number;
  limit?: number;
}

/**
 * Monotonic ownership proof attached to durable agent writes.
 *
 * In a distributed deployment the durability provider must validate this proof
 * atomically against the authoritative lease row before accepting the write.
 */
export interface AgentWriteFence {
  resourceId: string;
  ownerId: string;
  fencingToken: number;
}

export interface DurabilityProvider {
  /** Atomically create a new agent identity. Returns false when the id already exists. */
  createAgent(snapshot: AgentSnapshot): Promise<boolean>;
  /**
   * Unfenced write for bootstrap/single-writer mode. Distributed stores may
   * reject this once an agent has entered fenced ownership.
   */
  putAgent(snapshot: AgentSnapshot): Promise<void>;
  /**
   * Atomically persist an agent snapshot only if the supplied fencing proof is
   * still current. Returns false when the lease generation is stale/lost.
   */
  putAgentFenced?(snapshot: AgentSnapshot, fence: AgentWriteFence): Promise<boolean>;
  getAgent(id: AgentId): Promise<AgentSnapshot | undefined>;
  listAgents(): Promise<AgentSnapshot[]>;
  putTask(task: TaskSpec): Promise<void>;
  getTask(id: TaskId): Promise<TaskSpec | undefined>;
  putRelation(relation: Relation): Promise<void>;
  listRelations(): Promise<Relation[]>;
  appendEvent(event: RuntimeEvent): Promise<void>;
  listEvents(): Promise<RuntimeEvent[]>;
  /** Optional resumable event stream surface for multi-client/control-plane consumers. */
  readEvents?(options?: EventReadOptions): Promise<SequencedRuntimeEvent[]>;
  /** Optional retention primitive. Returns number of removed events. */
  pruneEvents?(throughSeq: number): Promise<number>;
}

export function agentFenceError(snapshot: AgentSnapshot, fence: AgentWriteFence): Error {
  return new Error(`AGENT_FENCE_REJECTED:${snapshot.id}:${fence.resourceId}:${fence.fencingToken}`);
}

export function isAgentFenceRejected(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("AGENT_FENCE_REJECTED:");
}

/** Persist one snapshot while preserving the hard-fencing contract. */
export async function persistAgentSnapshot(
  durability: DurabilityProvider,
  snapshot: AgentSnapshot,
  fence?: AgentWriteFence,
): Promise<void> {
  if (!fence) {
    await durability.putAgent(snapshot);
    return;
  }
  if (!durability.putAgentFenced) {
    throw new Error(`FENCED_AGENT_WRITE_UNSUPPORTED:${snapshot.id}`);
  }
  if (!(await durability.putAgentFenced(snapshot, fence))) {
    throw agentFenceError(snapshot, fence);
  }
}
