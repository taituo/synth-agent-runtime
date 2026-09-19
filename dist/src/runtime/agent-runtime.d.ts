import { type AgentId, type TaskId, type WorkspaceId } from "../core/ids.js";
import type { AgentDefinition, AgentMessage, AgentSnapshot, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import { type AgentWriteFence, type DurabilityProvider } from "../durability/types.js";
import type { RuntimeStateStore } from "../durability/runtime-state.js";
import type { MailboxStore, MailboxEnvelope } from "../control-plane/mailbox.js";
import { ExecutionBroker } from "../execution/broker.js";
import type { Effect, EffectResult } from "../execution/types.js";
import { MemoryWorkspace } from "../workspace/memory-workspace.js";
import type { AgentEngine } from "./agent-engine.js";
type Listener = (event: RuntimeEvent) => void;
export interface AgentRunOptions {
    fence?: AgentWriteFence;
}
export interface AgentRecoveryOptions {
    definition(definitionId: string, snapshot: AgentSnapshot): Promise<AgentDefinition> | AgentDefinition;
    engine(definition: AgentDefinition, snapshot: AgentSnapshot): Promise<AgentEngine> | AgentEngine;
    workspace?(snapshot: AgentSnapshot): Promise<MemoryWorkspace> | MemoryWorkspace;
    /** Non-terminal in-flight states cannot safely resume an arbitrary JS stack. Default: idle. */
    recoveredState?: AgentSnapshot["state"];
    /** Optional ownership proof for recovery writes in distributed deployments. */
    fence?(snapshot: AgentSnapshot): Promise<AgentWriteFence | undefined> | AgentWriteFence | undefined;
}
export interface RecoverResult {
    agents: number;
    workspaces: number;
    incompleteTurnsRolledBack: number;
    incompleteTurnsFailed: number;
}
export declare class AgentRuntime {
    #private;
    private readonly durability;
    private readonly executionBroker?;
    private readonly runtimeState?;
    private readonly mailboxStore?;
    readonly workspaces: Map<WorkspaceId, MemoryWorkspace>;
    constructor(durability: DurabilityProvider, executionBroker?: ExecutionBroker | undefined, workspaces?: Map<WorkspaceId, MemoryWorkspace>, runtimeState?: RuntimeStateStore | undefined, mailboxStore?: MailboxStore | undefined);
    createWorkspace(workspace?: MemoryWorkspace): Promise<MemoryWorkspace>;
    createTask(input: Omit<TaskSpec, "id" | "status"> & {
        id?: TaskId;
        status?: TaskSpec["status"];
    }): Promise<TaskSpec>;
    spawn(options: {
        definition: AgentDefinition;
        engine: AgentEngine;
        workspace: MemoryWorkspace;
        task?: TaskSpec;
        metadata?: Record<string, unknown>;
        id?: AgentId;
    }): Promise<AgentSnapshot>;
    /**
     * Rebuilds logical agents after control-plane restart. Arbitrary JS call stacks
     * are not resumed; non-terminal active states are normalized to `recoveredState`
     * and the durable mailbox/task/world remains available for a fresh engine turn.
     */
    recover(options: AgentRecoveryOptions): Promise<RecoverResult>;
    checkpointWorkspace(workspaceId: WorkspaceId, reason?: string): Promise<void>;
    /**
     * At-most-once logical command helper for retries from RPC/Temporal.
     *
     * By default, an exception leaves the command `started`/uncertain because the
     * callback may have crossed an external side-effect boundary before throwing.
     * Callers may opt into `retrySafeOnError` only when the command is known to be
     * replay-safe after an exception.
     */
    command<T>(id: string, run: () => Promise<T>, options?: {
        retrySafeOnError?: boolean;
    }): Promise<T>;
    addRelation(relation: Relation): Promise<void>;
    attach(listener: Listener): () => void;
    send(agentId: AgentId, text: string, role?: AgentMessage["role"], metadata?: Record<string, unknown>, messageId?: `${string}-${string}-${string}-${string}-${string}`): Promise<AgentMessage>;
    executeEffect(agentId: AgentId, effect: Effect, minFidelity?: number): Promise<EffectResult>;
    run(agentId: AgentId, options?: AgentRunOptions): Promise<unknown>;
    cancel(agentId: AgentId): void;
    get(agentId: AgentId): AgentSnapshot;
    forkAgent(parentId: AgentId, engine: AgentEngine, task?: TaskSpec): Promise<AgentSnapshot>;
    readMailbox(agentId: AgentId, consumerId?: string, limit?: number): Promise<MailboxEnvelope[]>;
    ackMailbox(agentId: AgentId, consumerId: string, throughSeq: number): Promise<void>;
}
export {};
