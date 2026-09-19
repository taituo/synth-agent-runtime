export class ChaosDurabilityProvider {
    inner;
    chaos;
    constructor(inner, chaos) {
        this.inner = inner;
        this.chaos = chaos;
        // Forward the optional durability surface only when the wrapped provider
        // actually implements it. Defining it unconditionally would make a caller's
        // capability check (`if (provider.putAgentFenced)`) lie — turning a store
        // that cannot fence into a silent fence rejection instead of the explicit
        // FENCED_AGENT_WRITE_UNSUPPORTED that persistAgentSnapshot raises.
        if (inner.putAgentFenced) {
            this.putAgentFenced = (snapshot, fence) => this.call("durability.putAgentFenced", () => inner.putAgentFenced(snapshot, fence));
        }
        if (inner.readEvents) {
            this.readEvents = (options) => this.call("durability.readEvents", () => inner.readEvents(options));
        }
        if (inner.pruneEvents) {
            this.pruneEvents = (throughSeq) => this.call("durability.pruneEvents", () => inner.pruneEvents(throughSeq));
        }
    }
    putAgentFenced;
    readEvents;
    pruneEvents;
    async createAgent(v) { return this.call("durability.createAgent", () => this.inner.createAgent(v)); }
    async putAgent(v) { return this.call("durability.putAgent", () => this.inner.putAgent(v)); }
    async getAgent(id) { return this.call("durability.getAgent", () => this.inner.getAgent(id)); }
    async listAgents() { return this.call("durability.listAgents", () => this.inner.listAgents()); }
    async putTask(v) { return this.call("durability.putTask", () => this.inner.putTask(v)); }
    async getTask(id) { return this.call("durability.getTask", () => this.inner.getTask(id)); }
    async putRelation(v) { return this.call("durability.putRelation", () => this.inner.putRelation(v)); }
    async listRelations() { return this.call("durability.listRelations", () => this.inner.listRelations()); }
    async appendEvent(v) { return this.call("durability.appendEvent", () => this.inner.appendEvent(v)); }
    async listEvents() { return this.call("durability.listEvents", () => this.inner.listEvents()); }
    async call(point, fn) {
        this.chaos.hit(`${point}.before`);
        const result = await fn();
        this.chaos.hit(`${point}.after`);
        return result;
    }
}
export class ChaosRuntimeStateStore {
    inner;
    chaos;
    constructor(inner, chaos) {
        this.inner = inner;
        this.chaos = chaos;
    }
    putCommand(v) { return this.call("state.putCommand", () => this.inner.putCommand(v)); }
    getCommand(id) { return this.call("state.getCommand", () => this.inner.getCommand(id)); }
    claimCommand(v) {
        if (!this.inner.claimCommand)
            return this.fallbackClaimCommand(v);
        return this.call("state.claimCommand", () => this.inner.claimCommand(v));
    }
    putWorkspaceCheckpoint(v) { return this.call("state.putWorkspaceCheckpoint", () => this.inner.putWorkspaceCheckpoint(v)); }
    getWorkspaceCheckpoint(id) { return this.call("state.getWorkspaceCheckpoint", () => this.inner.getWorkspaceCheckpoint(id)); }
    putTurn(v) { return this.call("state.putTurn", () => this.inner.putTurn(v)); }
    getTurn(id) { return this.call("state.getTurn", () => this.inner.getTurn(id)); }
    listTurns(status) { return this.call("state.listTurns", () => this.inner.listTurns(status)); }
    putEffect(v) { return this.call("state.putEffect", () => this.inner.putEffect(v)); }
    getEffect(id) { return this.call("state.getEffect", () => this.inner.getEffect(id)); }
    claimEffect(v) {
        if (!this.inner.claimEffect)
            return this.fallbackClaimEffect(v);
        return this.call("state.claimEffect", () => this.inner.claimEffect(v));
    }
    async fallbackClaimCommand(v) {
        const existing = await this.getCommand(v.id);
        if (existing?.status === "started" || existing?.status === "committed")
            return { claimed: false, record: existing };
        await this.putCommand(v);
        return { claimed: true, record: structuredClone(v) };
    }
    async fallbackClaimEffect(v) {
        const existing = await this.getEffect(v.id);
        if (existing)
            return { claimed: false, record: existing };
        await this.putEffect(v);
        return { claimed: true, record: structuredClone(v) };
    }
    async call(point, fn) {
        this.chaos.hit(`${point}.before`);
        const result = await fn();
        this.chaos.hit(`${point}.after`);
        return result;
    }
}
export class ChaosExecutor {
    inner;
    chaos;
    id;
    fidelity;
    resourceClassId;
    constructor(inner, chaos, id = `chaos:${inner.id}`) {
        this.inner = inner;
        this.chaos = chaos;
        this.id = id;
        this.fidelity = inner.fidelity;
        this.resourceClassId = inner.resourceClassId;
    }
    async canExecute(effect, context) {
        this.chaos.hit("executor.canExecute.before");
        const value = await this.inner.canExecute(effect, context);
        this.chaos.hit("executor.canExecute.after");
        return value;
    }
    async execute(effect, context) {
        this.chaos.hit("executor.execute.before");
        const value = await this.inner.execute(effect, context);
        this.chaos.hit("executor.execute.after");
        return value;
    }
}
export class ChaosGatewayBackend {
    inner;
    chaos;
    constructor(inner, chaos) {
        this.inner = inner;
        this.chaos = chaos;
    }
    async listModels() {
        this.chaos.hit("gateway.listModels.before");
        const result = await this.inner.listModels();
        this.chaos.hit("gateway.listModels.after");
        return result;
    }
    async handle(request, model) {
        this.chaos.hit("gateway.handle.before");
        const result = await this.inner.handle(request, model);
        this.chaos.hit("gateway.handle.after");
        return result;
    }
}
