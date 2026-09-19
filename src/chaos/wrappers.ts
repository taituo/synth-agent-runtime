import type { AgentId, TaskId } from "../core/ids.js";
import type { AgentSnapshot, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import type { DurabilityProvider } from "../durability/types.js";
import type {
  DurableCommandRecord,
  DurableEffectRecord,
  DurableTurnRecord,
  DurableWorkspaceCheckpoint,
  RuntimeStateStore,
  TurnStatus,
} from "../durability/runtime-state.js";
import type { Effect, EffectContext, EffectResult, Executor } from "../execution/types.js";
import { ChaosController } from "./faults.js";

export class ChaosDurabilityProvider implements DurabilityProvider {
  constructor(readonly inner: DurabilityProvider, readonly chaos: ChaosController) {}
  async createAgent(v: AgentSnapshot) { return this.call("durability.createAgent", () => this.inner.createAgent(v)); }
  async putAgent(v: AgentSnapshot) { return this.call("durability.putAgent", () => this.inner.putAgent(v)); }
  async getAgent(id: AgentId) { return this.call("durability.getAgent", () => this.inner.getAgent(id)); }
  async listAgents() { return this.call("durability.listAgents", () => this.inner.listAgents()); }
  async putTask(v: TaskSpec) { return this.call("durability.putTask", () => this.inner.putTask(v)); }
  async getTask(id: TaskId) { return this.call("durability.getTask", () => this.inner.getTask(id)); }
  async putRelation(v: Relation) { return this.call("durability.putRelation", () => this.inner.putRelation(v)); }
  async listRelations() { return this.call("durability.listRelations", () => this.inner.listRelations()); }
  async appendEvent(v: RuntimeEvent) { return this.call("durability.appendEvent", () => this.inner.appendEvent(v)); }
  async listEvents() { return this.call("durability.listEvents", () => this.inner.listEvents()); }
  private async call<T>(point: string, fn: () => Promise<T>): Promise<T> {
    this.chaos.hit(`${point}.before`);
    const result = await fn();
    this.chaos.hit(`${point}.after`);
    return result;
  }
}

export class ChaosRuntimeStateStore implements RuntimeStateStore {
  constructor(readonly inner: RuntimeStateStore, readonly chaos: ChaosController) {}
  putCommand(v: DurableCommandRecord) { return this.call("state.putCommand", () => this.inner.putCommand(v)); }
  getCommand(id: string) { return this.call("state.getCommand", () => this.inner.getCommand(id)); }
  claimCommand(v: DurableCommandRecord) {
    if (!this.inner.claimCommand) return this.fallbackClaimCommand(v);
    return this.call("state.claimCommand", () => this.inner.claimCommand!(v));
  }
  putWorkspaceCheckpoint(v: DurableWorkspaceCheckpoint) { return this.call("state.putWorkspaceCheckpoint", () => this.inner.putWorkspaceCheckpoint(v)); }
  getWorkspaceCheckpoint(id: DurableWorkspaceCheckpoint["workspaceId"]) { return this.call("state.getWorkspaceCheckpoint", () => this.inner.getWorkspaceCheckpoint(id)); }
  putTurn(v: DurableTurnRecord) { return this.call("state.putTurn", () => this.inner.putTurn(v)); }
  getTurn(id: string) { return this.call("state.getTurn", () => this.inner.getTurn(id)); }
  listTurns(status?: TurnStatus) { return this.call("state.listTurns", () => this.inner.listTurns(status)); }
  putEffect(v: DurableEffectRecord) { return this.call("state.putEffect", () => this.inner.putEffect(v)); }
  getEffect(id: string) { return this.call("state.getEffect", () => this.inner.getEffect(id)); }
  claimEffect(v: DurableEffectRecord) {
    if (!this.inner.claimEffect) return this.fallbackClaimEffect(v);
    return this.call("state.claimEffect", () => this.inner.claimEffect!(v));
  }
  private async fallbackClaimCommand(v: DurableCommandRecord) {
    const existing = await this.getCommand(v.id);
    if (existing?.status === "started" || existing?.status === "committed") return { claimed: false, record: existing };
    await this.putCommand(v);
    return { claimed: true, record: structuredClone(v) };
  }
  private async fallbackClaimEffect(v: DurableEffectRecord) {
    const existing = await this.getEffect(v.id);
    if (existing) return { claimed: false, record: existing };
    await this.putEffect(v);
    return { claimed: true, record: structuredClone(v) };
  }
  private async call<T>(point: string, fn: () => Promise<T>): Promise<T> {
    this.chaos.hit(`${point}.before`);
    const result = await fn();
    this.chaos.hit(`${point}.after`);
    return result;
  }
}

export class ChaosExecutor implements Executor {
  readonly id: string;
  readonly fidelity: number;
  readonly resourceClassId?: Executor["resourceClassId"];
  constructor(readonly inner: Executor, readonly chaos: ChaosController, id = `chaos:${inner.id}`) {
    this.id = id;
    this.fidelity = inner.fidelity;
    this.resourceClassId = inner.resourceClassId;
  }
  async canExecute(effect: Effect, context: EffectContext): Promise<boolean> {
    this.chaos.hit("executor.canExecute.before");
    const value = await this.inner.canExecute(effect, context);
    this.chaos.hit("executor.canExecute.after");
    return value;
  }
  async execute(effect: Effect, context: EffectContext): Promise<EffectResult> {
    this.chaos.hit("executor.execute.before");
    const value = await this.inner.execute(effect, context);
    this.chaos.hit("executor.execute.after");
    return value;
  }
}

import type { GatewayBackend, GatewayModel } from "../inference/gateway/types.js";

export class ChaosGatewayBackend implements GatewayBackend {
  constructor(readonly inner: GatewayBackend, readonly chaos: ChaosController) {}
  async listModels(): Promise<GatewayModel[]> {
    this.chaos.hit("gateway.listModels.before");
    const result = await this.inner.listModels();
    this.chaos.hit("gateway.listModels.after");
    return result;
  }
  async handle(request: Request, model: string): Promise<Response> {
    this.chaos.hit("gateway.handle.before");
    const result = await this.inner.handle(request, model);
    this.chaos.hit("gateway.handle.after");
    return result;
  }
}
