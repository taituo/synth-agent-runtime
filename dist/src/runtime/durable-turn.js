import { randomUUID } from "node:crypto";
import { serializeWorkspaceSnapshot } from "../workspace/snapshot-codec.js";
/**
 * Transaction boundary around one model/agent attempt.
 *
 * Output/tool events are buffered until commit. Workspace changes are restored on
 * rollback. Irreversible effects should be classified as `commit` (deferred) or
 * `barrier` (execute now and make the attempt non-retryable).
 */
export class DurableTurn {
    id;
    #outputs = [];
    #tools = [];
    #stagedEffects = [];
    #effectResults = new Map();
    #options;
    #semanticExposed = false;
    #closed = false;
    #persistTail = Promise.resolve();
    #persistError;
    #record;
    #baseSnapshot;
    constructor(options) {
        this.#options = options;
        this.id = options.turnId ?? `turn_${randomUUID()}`;
    }
    static async begin(options) {
        const turn = new DurableTurn(options);
        turn.#baseSnapshot = await options.workspace.snapshot();
        const now = Date.now();
        turn.#record = {
            id: turn.id,
            agentId: options.agentId,
            workspaceId: options.workspace.id,
            attemptId: options.attemptId,
            status: "started",
            startedAt: now,
            updatedAt: now,
            base: serializeWorkspaceSnapshot(turn.#baseSnapshot),
            semanticExposed: false,
            bufferedOutputCount: 0,
            stagedEffectIds: [],
        };
        await options.store?.putTurn(turn.#record);
        return turn;
    }
    emitOutput(text) {
        this.#assertOpen();
        this.#outputs.push(text);
        this.#scheduleSyncRecord();
    }
    emitTool(name, phase, data) {
        this.#assertOpen();
        this.#tools.push({ name, phase, data });
    }
    /** Explicitly marks that behavior escaped the transaction boundary. */
    markSemanticExposure() {
        this.#semanticExposed = true;
        this.#scheduleSyncRecord();
    }
    get canRetry() {
        return !this.#semanticExposed;
    }
    get closed() {
        return this.#closed;
    }
    get bufferedOutputCount() {
        return this.#outputs.length;
    }
    stageEffect(effect) {
        this.#assertOpen();
        if (this.#stagedEffects.some((existing) => existing.id === effect.id))
            return;
        this.#stagedEffects.push(effect);
        this.#scheduleSyncRecord();
    }
    async executeEffect(effect) {
        this.#assertOpen();
        const cached = this.#effectResults.get(effect.id);
        if (cached)
            return structuredClone(cached);
        const mode = this.#options.classifyEffect?.(effect) ?? defaultEffectReplayMode(effect);
        if (mode === "commit") {
            this.stageEffect(effect);
            const result = { ok: true, output: { staged: true, effectId: effect.id } };
            this.#effectResults.set(effect.id, result);
            return structuredClone(result);
        }
        if (!this.#options.executeEffect)
            return { ok: false, error: "No effect executor configured" };
        if (mode === "barrier") {
            // Persist the retry barrier before crossing the external boundary. If the
            // process dies after the effect starts, recovery must not treat the turn
            // as transparently retryable.
            this.#semanticExposed = true;
            await this.#syncRecord();
        }
        // Attempt-local effects must not reuse a global durable receipt after this
        // attempt is rolled back. Scope their idempotency key to the durable turn.
        // Commit/barrier effects keep the caller-provided stable id because they may
        // cross the transaction boundary and must never be blindly duplicated.
        const executionEffect = mode === "attempt-local"
            ? { ...effect, id: `${effect.id}::${this.id}` }
            : effect;
        const result = await this.#options.executeEffect(executionEffect);
        this.#effectResults.set(effect.id, structuredClone(result));
        return result;
    }
    async commit() {
        this.#assertOpen();
        // Flush fire-and-forget metadata updates before any externally visible
        // commit action. This also surfaces a failed durability write before the
        // transaction can escape its rollback boundary.
        await this.#flushPersistence();
        // Commit-staged effects are intentionally executed before output is published.
        // Effect IDs are expected to be idempotency keys at the executor boundary.
        for (const effect of this.#stagedEffects) {
            if (!this.#options.executeEffect)
                throw new Error(`Cannot commit staged effect ${effect.id}: no executor`);
            this.#semanticExposed = true;
            await this.#syncRecord();
            const result = await this.#options.executeEffect(effect);
            this.#effectResults.set(effect.id, structuredClone(result));
            if (!result.ok) {
                await this.#fail(`Commit effect ${effect.id} failed: ${result.error ?? "unknown error"}`);
                throw new Error(`Commit effect ${effect.id} failed: ${result.error ?? "unknown error"}`);
            }
        }
        // Publishing buffered tool/output semantics is itself an external boundary.
        // Persist that fact first so a crash during publication cannot be recovered
        // as a transparent retry that might duplicate already-visible output.
        if (this.#tools.length > 0 || this.#outputs.length > 0) {
            this.#semanticExposed = true;
            await this.#syncRecord();
        }
        for (const tool of this.#tools)
            await this.#options.publishTool?.(tool);
        for (const output of this.#outputs)
            await this.#options.publishOutput?.(output);
        this.#closed = true;
        this.#record = { ...this.#record, status: "committed", updatedAt: Date.now(), semanticExposed: this.#semanticExposed };
        await this.#persistTerminalRecord();
    }
    async rollback(error) {
        this.#assertOpen();
        this.#options.workspace.restore(this.#baseSnapshot);
        await this.#flushPersistence();
        this.#closed = true;
        this.#record = {
            ...this.#record,
            status: "rolled_back",
            error: error === undefined ? undefined : message(error),
            updatedAt: Date.now(),
            semanticExposed: this.#semanticExposed,
        };
        await this.#persistTerminalRecord();
    }
    async fail(error) {
        this.#assertOpen();
        await this.#fail(message(error));
    }
    async #fail(error) {
        this.#options.workspace.restore(this.#baseSnapshot);
        await this.#flushPersistence();
        this.#closed = true;
        this.#record = {
            ...this.#record,
            status: "failed",
            error,
            updatedAt: Date.now(),
            semanticExposed: this.#semanticExposed,
        };
        await this.#persistTerminalRecord();
    }
    #scheduleSyncRecord() {
        if (!this.#record || this.#closed)
            return;
        this.#record = {
            ...this.#record,
            updatedAt: Date.now(),
            semanticExposed: this.#semanticExposed,
            bufferedOutputCount: this.#outputs.length,
            stagedEffectIds: this.#stagedEffects.map((effect) => effect.id),
        };
        this.#enqueueRecord(this.#record);
    }
    async #syncRecord() {
        this.#scheduleSyncRecord();
        await this.#flushPersistence();
    }
    #enqueueRecord(record) {
        const store = this.#options.store;
        if (!store)
            return;
        const snapshot = structuredClone(record);
        this.#persistTail = this.#persistTail.then(async () => {
            if (this.#persistError !== undefined)
                return;
            try {
                await store.putTurn(snapshot);
            }
            catch (error) {
                this.#persistError = error;
            }
        });
    }
    async #flushPersistence() {
        await this.#persistTail;
        if (this.#persistError !== undefined)
            throw this.#persistError;
    }
    async #persistTerminalRecord() {
        this.#enqueueRecord(this.#record);
        await this.#flushPersistence();
    }
    #assertOpen() {
        if (this.#closed)
            throw new Error(`Turn ${this.id} is already closed`);
    }
}
export async function runDurableTransactionalTurn(options) {
    if (options.attempts.length === 0)
        throw new Error("At least one durable turn attempt is required");
    let lastError;
    for (const attempt of options.attempts) {
        const turn = await DurableTurn.begin({ ...options, attemptId: attempt.id });
        options.onAttempt?.({ type: "start", attemptId: attempt.id, turnId: turn.id });
        try {
            const result = await attempt.run(turn);
            await turn.commit();
            options.onAttempt?.({ type: "commit", attemptId: attempt.id, turnId: turn.id });
            return result;
        }
        catch (error) {
            lastError = error;
            if (turn.closed) {
                options.onAttempt?.({ type: "failed", attemptId: attempt.id, turnId: turn.id, error: message(error) });
                throw error;
            }
            const retry = turn.canRetry && attempt.retryable(error, turn);
            if (retry) {
                await turn.rollback(error);
                options.onAttempt?.({ type: "rollback", attemptId: attempt.id, turnId: turn.id, error: message(error) });
                continue;
            }
            await turn.fail(error);
            options.onAttempt?.({ type: "failed", attemptId: attempt.id, turnId: turn.id, error: message(error) });
            throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "All durable turn attempts failed"));
}
export function defaultEffectReplayMode(effect) {
    switch (effect.kind) {
        case "workspace.read":
        case "workspace.write":
        case "workspace.replace":
        case "workspace.delete":
        case "workspace.symlink":
        case "workspace.list":
        case "workspace.export":
        case "process.exec":
            return "attempt-local";
        case "workflow.run":
            return "commit";
        case "human.approval":
            return "barrier";
    }
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
