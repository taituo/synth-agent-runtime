export class PolicyEffectGate {
    policy;
    execute;
    requestApproval;
    constructor(policy, execute, requestApproval) {
        this.policy = policy;
        this.execute = execute;
        this.requestApproval = requestApproval;
    }
    async run(agentId, effect) {
        const decision = await this.policy.evaluate({ agentId, effect });
        if (!decision.allow && !decision.requireApproval) {
            return { ok: false, error: decision.reason ?? "Effect denied by policy" };
        }
        if (decision.requireApproval) {
            if (!this.requestApproval)
                return { ok: false, error: "Effect requires approval but no approval channel is configured" };
            const approved = await this.requestApproval({
                id: `approval-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                agentId,
                effect,
                reason: decision.reason,
                createdAt: Date.now(),
            });
            if (!approved)
                return { ok: false, error: "Effect approval denied" };
        }
        return this.execute(effect);
    }
}
export class AllowlistEffectPolicy {
    allowedKinds;
    approvalKinds;
    constructor(allowedKinds, approvalKinds = new Set()) {
        this.allowedKinds = allowedKinds;
        this.approvalKinds = approvalKinds;
    }
    evaluate({ effect }) {
        if (this.allowedKinds.has(effect.kind))
            return { allow: true };
        if (this.approvalKinds.has(effect.kind))
            return { allow: false, requireApproval: true, reason: `${effect.kind} requires approval` };
        return { allow: false, reason: `${effect.kind} is not permitted` };
    }
}
