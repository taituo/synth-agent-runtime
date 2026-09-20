/**
 * Priority lanes for scarce subscription quota (spec:
 * /tmp/opencode/spec-priority-lanes.md, roadmap item 2).
 *
 * Pure and clock-injected so decisions are unit-testable with a fake clock and
 * no timers. Piece 1 covers the lane model, band ordering and queue-or-reject;
 * weighted fair-share within a band and real cooldowns are later pieces.
 *
 * Capacity here is a concurrency cap. In deployment it is derived from the
 * per-window quota (open question 1 in the spec); the window arithmetic itself
 * is a later piece.
 */
export type LaneId = string;
export interface LaneSpec {
    id: LaneId;
    /** Higher runs first. Bands are strictly ordered; weights apply within a band. */
    priority: number;
    /** Relative share within the band (used by the fair-share piece). */
    weight: number;
    /** Max time a request may wait in this lane before rejection. 0 = never queue. */
    maxWaitMs: number;
}
export interface AdmissionRequest {
    lane: LaneId;
    tenantId: string;
    /** Stable key so one tenant's requests queue fairly among themselves. */
    key: string;
    /** Informational; the scheduler's own clock is authoritative for deadlines. */
    at: number;
}
export type AdmissionRejection = "unknown-lane" | "lane-full" | "deadline" | "rate-limited";
export type AdmissionDecision = {
    outcome: "admit";
} | {
    outcome: "queue";
    retryAfterMs: number;
    ticket: string;
} | {
    outcome: "reject";
    reason: AdmissionRejection;
    retryAfterMs: number;
};
export interface LaneSchedulerOptions {
    /** Concurrent admissions allowed before requests queue or reject. */
    capacity: number;
    now?: () => number;
    /** Lane used when a request names an unknown lane; defaults to the lowest-priority lane. */
    defaultLane?: LaneId;
}
export declare class LaneScheduler {
    #private;
    constructor(lanes: readonly LaneSpec[], options: LaneSchedulerOptions);
    /** Admit now, enqueue with a bounded wait, or reject. */
    admit(request: AdmissionRequest): AdmissionDecision;
    /**
     * Free one slot and hand back the next queued request to run: the highest
     * band first, so an interactive request never waits behind batch work. The
     * caller is responsible for honouring the returned request (or calling
     * `release` again if it was cancelled).
     */
    release(): AdmissionRequest | undefined;
    pending(): readonly AdmissionRequest[];
    inFlight(): number;
    lane(id: LaneId): LaneSpec | undefined;
}
