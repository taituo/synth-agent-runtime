/**
 * Helpers for the Track 2 messy corpus: schema validation, the ground-truth
 * "script" shape, and a scorer that separates accuracy (scorable items) from
 * structural integrity (every item, including ambiguous/hostile ones).
 */
import { MESSY_EVENTS, type CorpusClass, type CorpusItem } from "./corpora/messy-events.js";

/** Classes the model is allowed to answer with (mirrors the gateway activity). */
export const CORPUS_CLASSES = ["news", "social_post", "incident"] as const;

/**
 * Accuracy gate for the messy corpus. MEASURED, not guessed.
 *
 * Baseline (2026-09-19, `muse-spark-1.3-contributor` via the local gateway):
 * 12/12 = 1.0. The four NVD CVE descriptions were reclassified from `incident`
 * to `news` on 2026-09-19: a CVE is factual institutional reporting, which the
 * triage prompt's own definition calls `news`, not "an operational alert about
 * a system failure or degradation that needs action". The earlier 0.6 gate
 * existed only to absorb that labelling error, so it was replaced. The gate is
 * 0.9 — below the measured 1.0 for natural model variance, but not so low that
 * it would excuse a mislabelled item. Update only with a fresh measurement and
 * a new date.
 */
export const CORPUS_ACCURACY_GATE = 0.9;
export const CORPUS_BASELINE = "2026-09-19: 12/12 = 1.0 (muse-spark-1.3-contributor), after CVE relabel to news";

export interface CorpusTurn {
  plantedKinds: ReadonlyArray<string | null>;
  classifications: ReadonlyArray<{ classification: string }>;
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

export function assertCorpusSchema(items: readonly CorpusItem[] = MESSY_EVENTS): void {
  const ids = new Set<string>();
  const classes = new Set<CorpusClass>(["news", "social_post", "incident", "ambiguous"]);
  for (const item of items) {
    if (!item.id) throw new Error("corpus item missing id");
    if (ids.has(item.id)) throw new Error(`duplicate corpus id: ${item.id}`);
    ids.add(item.id);
    if (!item.source || !item.license) throw new Error(`${item.id}: missing source/license`);
    if (!classes.has(item.expectedClass)) throw new Error(`${item.id}: bad expectedClass ${item.expectedClass}`);
    if (item.provenance !== "real" && item.provenance !== "synthetic") throw new Error(`${item.id}: bad provenance`);
    if (item.expectedClass === "ambiguous" && !item.note) throw new Error(`${item.id}: ambiguous item needs a note`);
  }
}

/** The signal `kind` we plant for each item (the model never sees it). */
export function corpusScript(items: readonly CorpusItem[] = MESSY_EVENTS) {
  return items.map((item, index) => ({ kind: item.expectedClass, text: item.text, delayMs: index === 0 ? 0 : 150 }));
}

export function scoreCorpus(items: readonly CorpusItem[], turns: readonly CorpusTurn[]): CorpusScore {
  const plantedFlat = turns.flatMap((turn) => [...turn.plantedKinds]);
  const gotFlat = turns.flatMap((turn) => turn.classifications.map((entry) => entry.classification));
  const allowed = new Set<string>(CORPUS_CLASSES);

  const orderOk =
    plantedFlat.length === items.length &&
    items.every((item, index) => plantedFlat[index] === item.expectedClass) &&
    gotFlat.length === items.length;

  const mismatches: CorpusMismatch[] = [];
  let scorable = 0;
  let correct = 0;
  items.forEach((item, index) => {
    if (item.expectedClass === "ambiguous") return;
    scorable++;
    const got = gotFlat[index];
    if (got === item.expectedClass) correct++;
    else mismatches.push({ id: item.id, text: item.text, planted: item.expectedClass, got: got ?? "(missing)" });
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
    injectionShapeOk: hostileIndexes.every((index) => typeof gotFlat[index] === "string" && allowed.has(gotFlat[index]!)),
  };
}
