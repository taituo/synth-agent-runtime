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

export class PolicyEffectGate {
  constructor(
    private readonly policy: EffectPolicy,
    private readonly execute: (effect: Effect) => Promise<EffectResult>,
    private readonly requestApproval?: (request: ApprovalRequest) => Promise<boolean>,
  ) {}

  async run(agentId: AgentId, effect: Effect): Promise<EffectResult> {
    const decision = await this.policy.evaluate({ agentId, effect });
    if (!decision.allow && !decision.requireApproval) {
      return { ok: false, error: decision.reason ?? "Effect denied by policy" };
    }
    if (decision.requireApproval) {
      if (!this.requestApproval) return { ok: false, error: "Effect requires approval but no approval channel is configured" };
      const approved = await this.requestApproval({
        id: `approval-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        agentId,
        effect,
        reason: decision.reason,
        createdAt: Date.now(),
      });
      if (!approved) return { ok: false, error: "Effect approval denied" };
    }
    return this.execute(effect);
  }
}

export class AllowlistEffectPolicy implements EffectPolicy {
  constructor(
    private readonly allowedKinds: ReadonlySet<Effect["kind"]>,
    private readonly approvalKinds: ReadonlySet<Effect["kind"]> = new Set(),
  ) {}

  evaluate({ effect }: EffectPolicyContext): EffectDecision {
    if (this.allowedKinds.has(effect.kind)) return { allow: true };
    if (this.approvalKinds.has(effect.kind)) return { allow: false, requireApproval: true, reason: `${effect.kind} requires approval` };
    return { allow: false, reason: `${effect.kind} is not permitted` };
  }
}
