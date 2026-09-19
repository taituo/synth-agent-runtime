import type { AgentId, ArtifactId, ProjectId, TaskId, WorkspaceId } from "../core/ids.js";
import type { AgentSnapshot, Artifact, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import type { AgentWriteFence, DurabilityProvider, EventReadOptions, SequencedRuntimeEvent } from "../durability/types.js";
import type { ClaimResult, DurableCommandRecord, DurableEffectRecord, DurableTurnRecord, DurableWorkspaceCheckpoint, RuntimeStateStore, TurnStatus } from "../durability/runtime-state.js";
import type { ArtifactCasResult, ProjectProjection, ProjectSpec, TaskCasResult, WorldCasResult, WorldStore } from "../world/types.js";
import type { PgExecutor } from "./types.js";
/**
 * One Postgres-backed implementation for runtime durability, transactional
 * receipts, and the canonical project/spec world.
 *
 * It deliberately uses simple UPSERTs + JSONB so schema evolution of agent
 * records is decoupled from SQL migrations. Identity/status columns remain
 * relational for atomic claims and recovery scans.
 */
export declare class PostgresPersistence implements DurabilityProvider, RuntimeStateStore, WorldStore {
    readonly db: PgExecutor;
    constructor(db: PgExecutor);
    createAgent(snapshot: AgentSnapshot): Promise<boolean>;
    putAgent(snapshot: AgentSnapshot): Promise<void>;
    putAgentFenced(snapshot: AgentSnapshot, fence: AgentWriteFence): Promise<boolean>;
    getAgent(id: AgentId): Promise<AgentSnapshot | undefined>;
    listAgents(): Promise<AgentSnapshot[]>;
    putTask(task: TaskSpec): Promise<void>;
    compareAndSwapTask(task: TaskSpec, expectedRevision: number): Promise<TaskCasResult>;
    getTask(id: TaskId): Promise<TaskSpec | undefined>;
    putRelation(relation: Relation): Promise<void>;
    listRelations(): Promise<Relation[]>;
    appendEvent(event: RuntimeEvent): Promise<void>;
    listEvents(): Promise<RuntimeEvent[]>;
    readEvents(options?: EventReadOptions): Promise<SequencedRuntimeEvent[]>;
    pruneEvents(throughSeq: number): Promise<number>;
    putCommand(record: DurableCommandRecord): Promise<void>;
    getCommand(id: string): Promise<DurableCommandRecord | undefined>;
    claimCommand(record: DurableCommandRecord): Promise<ClaimResult<DurableCommandRecord>>;
    putWorkspaceCheckpoint(checkpoint: DurableWorkspaceCheckpoint): Promise<void>;
    getWorkspaceCheckpoint(workspaceId: WorkspaceId): Promise<DurableWorkspaceCheckpoint | undefined>;
    putTurn(record: DurableTurnRecord): Promise<void>;
    getTurn(id: string): Promise<DurableTurnRecord | undefined>;
    listTurns(status?: TurnStatus): Promise<DurableTurnRecord[]>;
    putEffect(record: DurableEffectRecord): Promise<void>;
    getEffect(id: string): Promise<DurableEffectRecord | undefined>;
    claimEffect(record: DurableEffectRecord): Promise<ClaimResult<DurableEffectRecord>>;
    putProject(project: ProjectSpec): Promise<void>;
    compareAndSwapProject(project: ProjectSpec, expectedRevision: number): Promise<WorldCasResult>;
    getProject(id: ProjectId): Promise<ProjectSpec | undefined>;
    listProjects(): Promise<ProjectSpec[]>;
    putArtifact(artifact: Artifact): Promise<void>;
    compareAndSwapArtifact(artifact: Artifact, expectedRevision: number): Promise<ArtifactCasResult>;
    getArtifact(id: ArtifactId): Promise<Artifact | undefined>;
    projection(projectId: ProjectId): Promise<ProjectProjection | undefined>;
    private getBody;
    private listBodies;
}
