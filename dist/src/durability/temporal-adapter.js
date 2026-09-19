export class TemporalDurabilityProvider {
    bindings;
    constructor(bindings) {
        this.bindings = bindings;
    }
    createAgent(v) { return this.bindings.createAgent(v); }
    putAgent(v) { return this.bindings.putAgent(v); }
    getAgent(id) { return this.bindings.getAgent(id); }
    listAgents() { return this.bindings.listAgents(); }
    putTask(v) { return this.bindings.putTask(v); }
    getTask(id) { return this.bindings.getTask(id); }
    putRelation(v) { return this.bindings.putRelation(v); }
    listRelations() { return this.bindings.listRelations(); }
    appendEvent(v) { return this.bindings.appendEvent(v); }
    listEvents() { return this.bindings.listEvents(); }
}
