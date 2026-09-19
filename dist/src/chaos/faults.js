/** Deterministic failpoint engine for repeatable crash/failure tests. */
export class ChaosController {
    #rules;
    #counts = new Map();
    #history = [];
    constructor(rules = []) {
        this.#rules = rules.map((rule) => ({ ...rule }));
    }
    hit(point) {
        const count = (this.#counts.get(point) ?? 0) + 1;
        this.#counts.set(point, count);
        const rule = this.#rules.find((candidate) => candidate.point === point && shouldFire(candidate, count));
        this.#history.push({ point, count, fired: Boolean(rule), at: Date.now() });
        if (rule)
            throw new ChaosFault(point, count, rule.message ?? `Injected chaos fault at ${point}#${count}`);
    }
    history() { return structuredClone(this.#history); }
    count(point) { return this.#counts.get(point) ?? 0; }
}
export class ChaosFault extends Error {
    point;
    hitCount;
    code = "SYNTH_CHAOS_FAULT";
    constructor(point, hitCount, message) {
        super(message);
        this.point = point;
        this.hitCount = hitCount;
        this.name = "ChaosFault";
    }
}
function shouldFire(rule, count) {
    const nth = rule.nth ?? 1;
    return rule.repeat ? count >= nth : count === nth;
}
