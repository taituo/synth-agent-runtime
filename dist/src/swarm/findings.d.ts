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
import { type FindingKind, type SignalStream } from "./stream.js";
export interface ReportedFinding {
    /** Optional agent-supplied label. */
    id?: string;
    kind: FindingKind;
    summary: string;
    /** Event ids the finding cites. */
    evidence: string[];
}
export interface FindingScore {
    plantedCount: number;
    recovered: number;
    recall: number;
    recoveredIds: string[];
    missedIds: string[];
    reportedCount: number;
    matched: number;
    spurious: number;
    decoyReports: number;
    ambiguousReports: number;
    /** matched / (matched + spurious); 1 when nothing was reported. */
    precision: number;
}
/** Normalize an untrusted reported finding; invalid kinds are dropped. */
export declare function normalizeReportedFinding(value: unknown): ReportedFinding | undefined;
export declare function scoreFindings(stream: SignalStream, reported: readonly ReportedFinding[]): FindingScore;
/** Convenience: score against the default planted stream. */
export declare function scoreAgainstPlanted(reported: readonly ReportedFinding[], stream?: SignalStream): FindingScore;
