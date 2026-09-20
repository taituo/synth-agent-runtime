/**
 * Stage one of the signal swarm: a planted event stream with known ground truth.
 *
 * The code-fixing gym is scored by a held-out test. A finding about an event
 * stream has no equivalent test, so the ground truth is PLANTED in the stream:
 * a known escalating incident, a slow-burn pattern, a cross-source correlation,
 * decoys that look significant and are not, and genuinely ambiguous items that
 * are scored OUTSIDE the gate.
 *
 * Carry over the corpus lesson: ambiguous items stay ambiguous and are never
 * relabelled to agree with whichever model is running. Ground truth here is
 * authored once, before any model runs.
 */
export type EventSource = "status-page" | "monitoring" | "social" | "release-notes" | "support";
export interface StreamEvent {
    id: string;
    /** Minutes from the start of the stream, so ordering is explicit. */
    at: number;
    source: EventSource;
    text: string;
}
/** A finding kind the agent may report. Deliberately small and closed. */
export type FindingKind = "incident" | "slow-burn" | "correlation";
export declare const FINDING_KINDS: readonly FindingKind[];
export interface PlantedFinding {
    id: string;
    kind: FindingKind;
    summary: string;
    /** Event ids that evidence it. */
    evidence: readonly string[];
    /** `any`: one evidence id is enough. `all`: every evidence id must be cited. */
    match: "any" | "all";
}
export interface AmbiguousFinding {
    id: string;
    /** What it could be read as, either way. */
    note: string;
    evidence: readonly string[];
}
export interface Decoy {
    id: string;
    /** Why it looks significant but is not. */
    reason: string;
    evidence: readonly string[];
}
export interface SignalStream {
    name: string;
    events: readonly StreamEvent[];
    planted: readonly PlantedFinding[];
    ambiguous: readonly AmbiguousFinding[];
    decoys: readonly Decoy[];
}
export declare const PLANTED_STREAM: SignalStream;
/** The stream as one JSON object per line, the form the tools read. */
export declare function streamToJsonl(stream?: SignalStream): string;
export declare function parseStreamJsonl(text: string): StreamEvent[];
/** Every event id referenced by planted, ambiguous or decoy ground truth. */
export declare function groundTruthEventIds(stream?: SignalStream): Set<string>;
