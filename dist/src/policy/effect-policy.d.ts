import type { AgentId } from "../core/ids.js";
import type { Effect, EffectResult } from "../execution/types.js";
export interface EffectDecision {
    allow: boolean;
    reason?: string;
    requireApproval?: boolean;
}
export interface EffectPolicyContext {
    agentId: AgentId;
    effect: Effect;
}
export interface EffectPolicy {
    evaluate(context: EffectPolicyContext): Promise<EffectDecision> | EffectDecision;
}
export interface ApprovalRequest {
    id: string;
    agentId: AgentId;
    effect: Effect;
    reason?: string;
    createdAt: number;
}
export declare class PolicyEffectGate {
    private readonly policy;
    private readonly execute;
    private readonly requestApproval?;
    constructor(policy: EffectPolicy, execute: (effect: Effect) => Promise<EffectResult>, requestApproval?: ((request: ApprovalRequest) => Promise<boolean>) | undefined);
    run(agentId: AgentId, effect: Effect): Promise<EffectResult>;
}
export declare class AllowlistEffectPolicy implements EffectPolicy {
    private readonly allowedKinds;
    private readonly approvalKinds;
    constructor(allowedKinds: ReadonlySet<Effect["kind"]>, approvalKinds?: ReadonlySet<Effect["kind"]>);
    evaluate({ effect }: EffectPolicyContext): EffectDecision;
}
