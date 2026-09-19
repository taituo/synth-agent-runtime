/** Resolves `started`/uncertain receipts without blindly replaying effects. */
export class EffectReconciler {
    state;
    probes;
    constructor(state, probes) {
        this.state = state;
        this.probes = probes;
    }
    async reconcile(effect, context) {
        const receipt = await this.state.getEffect(effect.id);
        if (!receipt)
            return { status: "unknown", detail: "no receipt" };
        if (receipt.status === "committed")
            return { status: "committed", result: structuredClone(receipt.result) };
        if (receipt.status === "failed")
            return { status: "failed", result: receipt.result ? structuredClone(receipt.result) : undefined, error: receipt.error ?? "effect failed" };
        const probe = this.probes.find((candidate) => candidate.supports(effect));
        if (!probe)
            return { status: "unknown", detail: `no reconciler for ${effect.kind}` };
        const outcome = await probe.reconcile(effect, context, receipt);
        const updatedAt = Date.now();
        if (outcome.status === "committed") {
            await this.state.putEffect({ ...receipt, status: "committed", result: outcome.result, error: undefined, updatedAt });
        }
        else if (outcome.status === "failed") {
            await this.state.putEffect({ ...receipt, status: "failed", result: outcome.result, error: outcome.error, updatedAt });
        }
        else {
            await this.state.putEffect({ ...receipt, status: "started", error: `${outcome.status}:${outcome.detail ?? "reconciliation incomplete"}`, updatedAt });
        }
        return outcome;
    }
}
