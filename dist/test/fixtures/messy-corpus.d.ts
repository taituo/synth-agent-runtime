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
/**
 * A corpus large and balanced enough to gate capability rather than only detect
 * regressions. `benchmarkReady` is false for the current corpus by design; this
 * constant makes the shortfall explicit and machine-checked instead of implied.
 */
export declare const CORPUS_BENCHMARK_MIN_ITEMS = 100;
export interface CorpusCoverage {
    total: number;
    scorable: number;
    ambiguous: number;
    byClass: Record<CorpusClass, number>;
    byProvenance: Record<"real" | "synthetic", number>;
    /** Scorable classes within ~10% of each other. */
    balanced: boolean;
    benchmarkReady: boolean;
}
export declare function corpusCoverage(items?: readonly CorpusItem[]): CorpusCoverage;
/**
 * An independent second annotator, as an explicit ambiguity procedure: a
 * deterministic lexical pass that must agree with the recorded human label. A
 * disagreement does not overwrite the label — it marks the item as needing a
 * human tie-break and excludes it from the gate (treated as ambiguous). This is
 * a sanity check against single-annotator drift, NOT a substitute for a second
 * human annotator; the corpus entry stays open until real texts can be licensed
 * across classes and a human agrees the labels.
 */
export declare function secondAnnotatorLabel(text: string): CorpusClass;
export interface AnnotationAgreement {
    agreements: string[];
    disagreements: Array<{
        id: string;
        expected: CorpusClass;
        second: CorpusClass;
    }>;
    agreementRate: number;
    /** Items the two annotators disagree on are excluded from the gate. */
    needsTieBreak: string[];
}
export declare function annotationAgreement(items?: readonly CorpusItem[]): AnnotationAgreement;
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
