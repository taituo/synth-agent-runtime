/**
 * Track 2: a realistic, MESSY event corpus.
 *
 * Today's `event-script.ts` texts were written by us to be unambiguous, which
 * is why 36/36 accuracy proves little. This corpus is deliberately not like
 * that: it mixes real public texts (public-domain CVE descriptions, CC BY-SA
 * Wikipedia extracts including a non-English one, an MIT repo's release note)
 * with synthetic items covering the shapes we cannot legally scrape (social
 * posts) and adversarial shapes (prompt injection, embedded reply-format JSON,
 * very long, near-empty, ambiguous). Both kinds are required by the spec.
 *
 * `expectedClass` is a human assignment; `"ambiguous"` items are EXCLUDED from
 * the accuracy gate but MUST still pass the structural checks (never lost,
 * duplicated or reordered; an injection must not change the reply's shape).
 *
 * AMBIGUITY NOTE (2026-09-20): the four `cve-*` items are `ambiguous` and so
 * EXCLUDED from accuracy. A published vulnerability report is genuinely both a
 * factual report (`news`) and an operational alert (`incident`); they were once
 * reclassified to `news` to agree with one model, which is tuning the measure.
 * They still carry the structural checks. Consequence: the scorable set is 8
 * items, which is too few to gate on as a benchmark — the gate is a smoke test
 * (see `CORPUS_BASELINE`).
 *
 * Provenance is per item: `source` and `license` are recorded, `provenance`
 * says whether the text is real or synthetic.
 */
export type CorpusClass = "news" | "social_post" | "incident" | "ambiguous";
export interface CorpusItem {
    id: string;
    text: string;
    expectedClass: CorpusClass;
    /** Where the text came from (URL or a description for synthetic items). */
    source: string;
    /** SPDX-ish license / rights statement. */
    license: string;
    provenance: "real" | "synthetic";
    note?: string;
}
export declare const MESSY_EVENTS: readonly CorpusItem[];
/** Items the accuracy gate scores; ambiguous/hostile items are structural-only. */
export declare const SCORABLE_ITEMS: CorpusItem[];
