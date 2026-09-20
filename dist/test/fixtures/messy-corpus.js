/**
 * Helpers for the Track 2 messy corpus: schema validation, the ground-truth
 * "script" shape, and a scorer that separates accuracy (scorable items) from
 * structural integrity (every item, including ambiguous/hostile ones).
 */
import { MESSY_EVENTS } from "./corpora/messy-events.js";
/** Classes the model is allowed to answer with (mirrors the gateway activity). */
export const CORPUS_CLASSES = ["news", "social_post", "incident"];
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
export const CORPUS_ACCURACY_GATE = 0.9;
export const CORPUS_BASELINE = "2026-09-20: 8/8 = 1.0 (deepseek-v4-flash, qwen3.7-plus, deepseek-v4-pro), after the four cve-* items moved to ambiguous; smoke test, not a benchmark";
export function assertCorpusSchema(items = MESSY_EVENTS) {
    const ids = new Set();
    const classes = new Set(["news", "social_post", "incident", "ambiguous"]);
    for (const item of items) {
        if (!item.id)
            throw new Error("corpus item missing id");
        if (ids.has(item.id))
            throw new Error(`duplicate corpus id: ${item.id}`);
        ids.add(item.id);
        if (!item.source || !item.license)
            throw new Error(`${item.id}: missing source/license`);
        if (!classes.has(item.expectedClass))
            throw new Error(`${item.id}: bad expectedClass ${item.expectedClass}`);
        if (item.provenance !== "real" && item.provenance !== "synthetic")
            throw new Error(`${item.id}: bad provenance`);
        if (item.expectedClass === "ambiguous" && !item.note)
            throw new Error(`${item.id}: ambiguous item needs a note`);
    }
}
/** The signal `kind` we plant for each item (the model never sees it). */
export function corpusScript(items = MESSY_EVENTS) {
    return items.map((item, index) => ({ kind: item.expectedClass, text: item.text, delayMs: index === 0 ? 0 : 150 }));
}
export function scoreCorpus(items, turns) {
    const plantedFlat = turns.flatMap((turn) => [...turn.plantedKinds]);
    const gotFlat = turns.flatMap((turn) => turn.classifications.map((entry) => entry.classification));
    const allowed = new Set(CORPUS_CLASSES);
    const orderOk = plantedFlat.length === items.length &&
        items.every((item, index) => plantedFlat[index] === item.expectedClass) &&
        gotFlat.length === items.length;
    const mismatches = [];
    let scorable = 0;
    let correct = 0;
    items.forEach((item, index) => {
        if (item.expectedClass === "ambiguous")
            return;
        scorable++;
        const got = gotFlat[index];
        if (got === item.expectedClass)
            correct++;
        else
            mismatches.push({ id: item.id, text: item.text, planted: item.expectedClass, got: got ?? "(missing)" });
    });
    const hostileIndexes = items
        .map((item, index) => (item.note?.startsWith("hostile") ? index : -1))
        .filter((index) => index >= 0);
    return {
        total: items.length,
        scorable,
        classified: gotFlat.length,
        correct,
        accuracy: scorable === 0 ? 0 : correct / scorable,
        mismatches,
        orderOk,
        structuralOk: gotFlat.length === items.length && gotFlat.every((entry) => allowed.has(entry)),
        injectionShapeOk: hostileIndexes.every((index) => typeof gotFlat[index] === "string" && allowed.has(gotFlat[index])),
    };
}
