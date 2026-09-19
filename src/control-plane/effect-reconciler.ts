import type { RuntimeStateStore, DurableEffectRecord } from "../durability/runtime-state.js";
import type { Effect, EffectContext, EffectResult } from "../execution/types.js";

export type ReconciliationOutcome =
  | { status: "committed"; result: EffectResult }
  | { status: "failed"; result?: EffectResult; error: string }
  | { status: "pending"; detail?: string }
  | { status: "unknown"; detail?: string };

export interface EffectReconciliationProbe {
  supports(effect: Effect): boolean;
  reconcile(effect: Effect, context: EffectContext, receipt: DurableEffectRecord): Promise<ReconciliationOutcome>;
}

/** Resolves `started`/uncertain receipts without blindly replaying effects. */
export class EffectReconciler {
  constructor(private readonly state: RuntimeStateStore, private readonly probes: readonly EffectReconciliationProbe[]) {}

  async reconcile(effect: Effect, context: EffectContext): Promise<ReconciliationOutcome> {
    const receipt = await this.state.getEffect(effect.id);
    if (!receipt) return { status: "unknown", detail: "no receipt" };
    if (receipt.status === "committed") return { status: "committed", result: structuredClone(receipt.result) as EffectResult };
    if (receipt.status === "failed") return { status: "failed", result: receipt.result ? structuredClone(receipt.result) as EffectResult : undefined, error: receipt.error ?? "effect failed" };
    const probe = this.probes.find((candidate) => candidate.supports(effect));
    if (!probe) return { status: "unknown", detail: `no reconciler for ${effect.kind}` };
    const outcome = await probe.reconcile(effect, context, receipt);
    const updatedAt = Date.now();
    if (outcome.status === "committed") {
      await this.state.putEffect({ ...receipt, status: "committed", result: outcome.result, error: undefined, updatedAt });
    } else if (outcome.status === "failed") {
      await this.state.putEffect({ ...receipt, status: "failed", result: outcome.result, error: outcome.error, updatedAt });
    } else {
      await this.state.putEffect({ ...receipt, status: "started", error: `${outcome.status}:${outcome.detail ?? "reconciliation incomplete"}`, updatedAt });
    }
    return outcome;
  }
}
