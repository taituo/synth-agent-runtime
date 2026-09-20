/**
 * Helpers for the Track 2 messy corpus: schema validation, the ground-truth
 * "script" shape, and a scorer that separates accuracy (scorable items) from
 * structural integrity (every item, including ambiguous/hostile ones).
 */
import { type CorpusClass, type CorpusItem } from "./corpora/messy-events.js";
/** Classes the model is allowed to answer with (mirrors the gateway activity). */
export declare const CORPUS_CLASSES: readonly ["news", "social_post", "incident"];
/**
 * Accuracy gate for the messy corpus. MEASURED, not guessed — and honest about
 * how little it measures.
 *
 * Baseline (2026-09-20, three models via the local gateway:
 * `deepseek-v4-flash`, `qwen3.7-plus`, `deepseek-v4-pro`): 8/8 = 1.0 each. The
 * four `cve-*` items are now `ambiguous` and excluded, because a published
 * vulnerability report is genuinely both factual reporting (`news`) and an
 * operational alert (`incident`). They had earlier been reclassified to `news`
 * to agree with one model — tuning the measure until the result looked good —
 * so that 12/12 baseline was withdrawn.
 *
 * The gate is 0.9, but this is a SMOKE TEST, not a benchmark: with only 8
 * scorable items, 7/8 = 0.875 already fails, so the gate effectively demands a
 * perfect score and detects regressions rather than measuring capability. A
 * corpus that could actually gate would need on the order of 100+ items,
 * balanced across the classes, with labels agreed by more than one annotator
 * (or an explicit ambiguity procedure) and the ambiguous set reported
 * separately. Update only with a fresh measurement and a new date.
 */
export declare const CORPUS_ACCURACY_GATE = 0.9;
export declare const CORPUS_BASELINE = "2026-09-20: 8/8 = 1.0 (deepseek-v4-flash, qwen3.7-plus, deepseek-v4-pro), after the four cve-* items moved to ambiguous; smoke test, not a benchmark";
export interface CorpusTurn {
    plantedKinds: ReadonlyArray<string | null>;
    classifications: ReadonlyArray<{
        classification: string;
    }>;
}
export interface CorpusMismatch {
    id: string;
    text: string;
    planted: string;
    got: string;
}
export interface CorpusScore {
    total: number;
    scorable: number;
    classified: number;
    correct: number;
    accuracy: number;
    mismatches: CorpusMismatch[];
    /** Every item was classified exactly once, in order. */
    orderOk: boolean;
    /** Every classification is a member of the allowed classes (shape intact). */
    structuralOk: boolean;
    /** Hostile (injection / embedded-JSON / empty) items kept the reply's shape. */
    injectionShapeOk: boolean;
}
export declare function assertCorpusSchema(items?: readonly CorpusItem[]): void;
/** The signal `kind` we plant for each item (the model never sees it). */
export declare function corpusScript(items?: readonly CorpusItem[]): {
    kind: CorpusClass;
    text: string;
    delayMs: number;
}[];
export declare function scoreCorpus(items: readonly CorpusItem[], turns: readonly CorpusTurn[]): CorpusScore;
