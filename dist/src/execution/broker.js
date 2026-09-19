export class ExecutionBroker {
    state;
    #executors;
    constructor(executors, state) {
        this.state = state;
        this.#executors = [...executors];
    }
    /**
     * Executes one effect with effect.id as the idempotency key.
     *
     * A committed receipt is replayed. A `started` receipt is treated as an
     * uncertain external side effect after a crash and is not automatically
     * repeated. This favors duplicate prevention over blind retry.
     */
    async execute(effect, context, minFidelity = 0) {
        const existing = await this.state?.getEffect(effect.id);
        if (existing?.status === "committed")
            return structuredClone(existing.result);
        if (existing?.status === "failed") {
            return existing.result
                ? structuredClone(existing.result)
                : { ok: false, error: existing.error ?? `EFFECT_PREVIOUSLY_FAILED:${effect.id}` };
        }
        if (existing?.status === "started") {
            return { ok: false, error: `EFFECT_OUTCOME_UNCERTAIN:${effect.id}` };
        }
        const startedAt = Date.now();
        const started = {
            id: effect.id,
            kind: effect.kind,
            status: "started",
            startedAt,
            updatedAt: startedAt,
        };
        if (this.state?.claimEffect) {
            const claim = await this.state.claimEffect(started);
            if (!claim.claimed) {
                if (claim.record.status === "committed")
                    return structuredClone(claim.record.result);
                if (claim.record.status === "failed") {
                    return claim.record.result
                        ? structuredClone(claim.record.result)
                        : { ok: false, error: claim.record.error ?? `EFFECT_PREVIOUSLY_FAILED:${effect.id}` };
                }
                return { ok: false, error: `EFFECT_OUTCOME_UNCERTAIN:${effect.id}` };
            }
        }
        else {
            await this.state?.putEffect(started);
        }
        const policy = context.executionPolicy;
        const floor = Math.max(minFidelity, policy?.minFidelity ?? 0);
        const preferred = effect.kind === "process.exec" ? (effect.resourceClass ?? policy?.preferredClass) : policy?.preferredClass;
        const candidates = [...this.#executors]
            .filter((executor) => executor.fidelity >= floor)
            .filter((executor) => !policy?.allowedClasses || !executor.resourceClassId || policy.allowedClasses.includes(executor.resourceClassId))
            .sort((a, b) => {
            const ap = preferred && a.resourceClassId === preferred ? 0 : 1;
            const bp = preferred && b.resourceClassId === preferred ? 0 : 1;
            return ap - bp || a.fidelity - b.fidelity;
        });
        let final = { ok: false, error: "No executor can satisfy effect" };
        try {
            for (const executor of candidates) {
                if (!(await executor.canExecute(effect, context)))
                    continue;
                const result = await executor.execute(effect, context);
                const decorated = { ...result, executor: executor.id, fidelity: executor.fidelity };
                final = decorated;
                if (result.ok)
                    break;
                if (result.error !== "ESCALATION_REQUIRED")
                    break;
                if (policy?.allowEscalation === false)
                    break;
            }
            if (final.ok) {
                await this.state?.putEffect({
                    id: effect.id,
                    kind: effect.kind,
                    status: "committed",
                    startedAt,
                    updatedAt: Date.now(),
                    result: final,
                });
            }
            else {
                await this.state?.putEffect({
                    id: effect.id,
                    kind: effect.kind,
                    status: "failed",
                    startedAt,
                    updatedAt: Date.now(),
                    error: final.error,
                    result: final,
                });
            }
            return final;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // The executor may have crossed an external side-effect boundary before
            // throwing. Keep the receipt in started/uncertain state so a retry cannot
            // blindly duplicate the effect. Reconciliation may later resolve it.
            await this.state?.putEffect({
                id: effect.id,
                kind: effect.kind,
                status: "started",
                startedAt,
                updatedAt: Date.now(),
                error: `uncertain:${message}`,
            });
            throw error;
        }
    }
}
