export interface FaultRule {
  /** Stable failpoint such as runtime.putAgent.before or executor.execute.after. */
  point: string;
  /** Fire on this matching hit (1-based). Default 1. */
  nth?: number;
  /** Fire on every hit at/after nth instead of once. */
  repeat?: boolean;
  message?: string;
}

export interface FaultHit {
  point: string;
  count: number;
  fired: boolean;
  at: number;
}

/** Deterministic failpoint engine for repeatable crash/failure tests. */
export class ChaosController {
  readonly #rules: FaultRule[];
  readonly #counts = new Map<string, number>();
  readonly #history: FaultHit[] = [];

  constructor(rules: readonly FaultRule[] = []) {
    this.#rules = rules.map((rule) => ({ ...rule }));
  }

  hit(point: string): void {
    const count = (this.#counts.get(point) ?? 0) + 1;
    this.#counts.set(point, count);
    const rule = this.#rules.find((candidate) => candidate.point === point && shouldFire(candidate, count));
    this.#history.push({ point, count, fired: Boolean(rule), at: Date.now() });
    if (rule) throw new ChaosFault(point, count, rule.message ?? `Injected chaos fault at ${point}#${count}`);
  }

  history(): FaultHit[] { return structuredClone(this.#history); }
  count(point: string): number { return this.#counts.get(point) ?? 0; }
}

export class ChaosFault extends Error {
  readonly code = "SYNTH_CHAOS_FAULT";
  constructor(readonly point: string, readonly hitCount: number, message: string) {
    super(message);
    this.name = "ChaosFault";
  }
}

function shouldFire(rule: FaultRule, count: number): boolean {
  const nth = rule.nth ?? 1;
  return rule.repeat ? count >= nth : count === nth;
}
