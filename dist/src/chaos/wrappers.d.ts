import type { AgentId, TaskId } from "../core/ids.js";
import type { AgentSnapshot, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import type { DurabilityProvider } from "../durability/types.js";
import type { DurableCommandRecord, DurableEffectRecord, DurableTurnRecord, DurableWorkspaceCheckpoint, RuntimeStateStore, TurnStatus } from "../durability/runtime-state.js";
import type { Effect, EffectContext, EffectResult, Executor } from "../execution/types.js";
import { ChaosController } from "./faults.js";
export declare class ChaosDurabilityProvider implements DurabilityProvider {
    readonly inner: DurabilityProvider;
    readonly chaos: ChaosController;
    constructor(inner: DurabilityProvider, chaos: ChaosController);
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
    private call;
}
export declare class ChaosRuntimeStateStore implements RuntimeStateStore {
    readonly inner: RuntimeStateStore;
    readonly chaos: ChaosController;
    constructor(inner: RuntimeStateStore, chaos: ChaosController);
    putCommand(v: DurableCommandRecord): Promise<void>;
    getCommand(id: string): Promise<DurableCommandRecord | undefined>;
    claimCommand(v: DurableCommandRecord): Promise<import("../durability/runtime-state.js").ClaimResult<DurableCommandRecord>>;
    putWorkspaceCheckpoint(v: DurableWorkspaceCheckpoint): Promise<void>;
    getWorkspaceCheckpoint(id: DurableWorkspaceCheckpoint["workspaceId"]): Promise<DurableWorkspaceCheckpoint | undefined>;
    putTurn(v: DurableTurnRecord): Promise<void>;
    getTurn(id: string): Promise<DurableTurnRecord | undefined>;
    listTurns(status?: TurnStatus): Promise<DurableTurnRecord[]>;
    putEffect(v: DurableEffectRecord): Promise<void>;
    getEffect(id: string): Promise<DurableEffectRecord | undefined>;
    claimEffect(v: DurableEffectRecord): Promise<import("../durability/runtime-state.js").ClaimResult<DurableEffectRecord>>;
    private fallbackClaimCommand;
    private fallbackClaimEffect;
    private call;
}
export declare class ChaosExecutor implements Executor {
    readonly inner: Executor;
    readonly chaos: ChaosController;
    readonly id: string;
    readonly fidelity: number;
    readonly resourceClassId?: Executor["resourceClassId"];
    constructor(inner: Executor, chaos: ChaosController, id?: string);
    canExecute(effect: Effect, context: EffectContext): Promise<boolean>;
    execute(effect: Effect, context: EffectContext): Promise<EffectResult>;
}
import type { GatewayBackend, GatewayModel } from "../inference/gateway/types.js";
export declare class ChaosGatewayBackend implements GatewayBackend {
    readonly inner: GatewayBackend;
    readonly chaos: ChaosController;
    constructor(inner: GatewayBackend, chaos: ChaosController);
    listModels(): Promise<GatewayModel[]>;
    handle(request: Request, model: string): Promise<Response>;
}
