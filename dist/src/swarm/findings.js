/**
 * Objective scoring for stage one: compare reported findings against the
 * planted ground truth. No judge, no model opinion — the same discipline as the
 * held-out test, adapted to a stream.
 *
 * Rules, stated once so they cannot drift:
 *   - A planted finding is RECOVERED when a reported finding has the same kind
 *     and cites its evidence (`any` = one id, `all` = every id).
 *   - A report that recovers nothing but cites only ambiguous evidence is scored
 *     separately and is NOT a false positive (the item is genuinely both).
 *   - A report that recovers nothing and cites decoy (or no) evidence is a false
 *     positive.
 *   - Ground truth is authored in the stream, never relabelled to fit a model.
 */
import { FINDING_KINDS, PLANTED_STREAM, } from "./stream.js";
function evidenceMatch(planted, reported) {
    const cited = new Set(reported.evidence);
    if (planted.match === "all")
        return planted.evidence.every((id) => cited.has(id));
    return planted.evidence.some((id) => cited.has(id));
}
function isKnownKind(kind) {
    return typeof kind === "string" && FINDING_KINDS.includes(kind);
}
/** Normalize an untrusted reported finding; invalid kinds are dropped. */
export function normalizeReportedFinding(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    if (!isKnownKind(record.kind))
        return undefined;
    const evidence = Array.isArray(record.evidence) ? record.evidence.filter((id) => typeof id === "string") : [];
    const summary = typeof record.summary === "string" ? record.summary : "";
    return { kind: record.kind, summary, evidence, ...(typeof record.id === "string" ? { id: record.id } : {}) };
}
export function scoreFindings(stream, reported) {
    const ambiguousEvidence = new Set(stream.ambiguous.flatMap((entry) => entry.evidence));
    const decoyEvidence = new Set(stream.decoys.flatMap((entry) => entry.evidence));
    const recoveredIds = [];
    const missedIds = [];
    for (const planted of stream.planted) {
        const hit = reported.some((finding) => finding.kind === planted.kind && evidenceMatch(planted, finding));
        (hit ? recoveredIds : missedIds).push(planted.id);
    }
    let matched = 0;
    let spurious = 0;
    let decoyReports = 0;
    let ambiguousReports = 0;
    for (const finding of reported) {
        const recovers = stream.planted.some((planted) => planted.kind === finding.kind && evidenceMatch(planted, finding));
        if (recovers) {
            matched += 1;
            continue;
        }
        const citesAmbiguous = finding.evidence.some((id) => ambiguousEvidence.has(id));
        const citesDecoy = finding.evidence.some((id) => decoyEvidence.has(id));
        if (citesAmbiguous && !citesDecoy)
            ambiguousReports += 1;
        else {
            if (citesDecoy)
                decoyReports += 1;
            spurious += 1;
        }
    }
    const plantedCount = stream.planted.length;
    const recovered = recoveredIds.length;
    return {
        plantedCount,
        recovered,
        recall: plantedCount === 0 ? 1 : recovered / plantedCount,
        recoveredIds,
        missedIds,
        reportedCount: reported.length,
        matched,
        spurious,
        decoyReports,
        ambiguousReports,
        precision: matched + spurious === 0 ? 1 : matched / (matched + spurious),
    };
}
/** Convenience: score against the default planted stream. */
export function scoreAgainstPlanted(reported, stream = PLANTED_STREAM) {
    return scoreFindings(stream, reported);
}
