/**
 * Priority lanes for scarce subscription quota (spec:
 * /tmp/opencode/spec-priority-lanes.md, roadmap item 2).
 *
 * Pure and clock-injected so decisions are unit-testable with a fake clock and
 * no timers. Covers the lane model, band ordering, queue-or-reject, weighted
 * fair-share within a band, and a reservation that stops a saturated high band
 * from starving a lower one (`lowerBandReserveFraction`). Real cooldowns are a
 * later piece.
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
export interface ReleasedAdmission {
    ticket: string;
    request: AdmissionRequest;
}
export interface LaneSchedulerOptions {
    /** Concurrent admissions allowed before requests queue or reject. */
    capacity: number;
    now?: () => number;
    /** Lane used when a request names an unknown lane; defaults to the lowest-priority lane. */
    defaultLane?: LaneId;
    /** Rough per-request service time, used to estimate a queued request's wait. */
    estimatedServiceMs?: number;
    /**
     * Fraction of admissions reserved for bands below the currently highest one,
     * so sustained high-band load cannot starve a lower band (spec: "each lower
     * band is reserved a fixed fraction of every window, e.g. >= 20%"). 0 disables
     * the reservation; default 0.2.
     */
    lowerBandReserveFraction?: number;
}
export declare class LaneScheduler {
    #private;
    constructor(lanes: readonly LaneSpec[], options: LaneSchedulerOptions);
    /** Admit now, enqueue with a bounded wait, or reject. */
    admit(request: AdmissionRequest): AdmissionDecision;
    /**
     * Reject queued requests that have waited longer than their lane allows.
     * Returns them with `reason: "deadline"` so the caller can propagate a
     * `Retry-After`. The scheduler's own clock is authoritative (open question 7).
     */
    expire(at?: number): Array<{
        request: AdmissionRequest;
        reason: "deadline";
        retryAfterMs: number;
    }>;
    /**
     * Free one slot and hand back the next queued request to run: the highest
     * band first, so an interactive request never waits behind batch work. The
     * caller is responsible for honouring the returned request (or calling
     * `release` again if it was cancelled).
     */
    release(): ReleasedAdmission | undefined;
    /** Drop a queued request (e.g. its waiter gave up). Returns whether it was queued. */
    cancel(ticket: string): boolean;
    pending(): readonly AdmissionRequest[];
    inFlight(): number;
    lane(id: LaneId): LaneSpec | undefined;
}
/** An admission failure that carries the server's `Retry-After` hint in ms. */
export declare function laneError(reason: AdmissionRejection, retryAfterMs: number): Error;
export interface PriorityLanePolicyOptions {
    defaultLane?: LaneId;
    now?: () => number;
}
/**
 * Gateway policy that admits requests through a {@link LaneScheduler}.
 *
 * `authorize` either admits immediately, rejects with a `Retry-After` hint, or
 * waits (bounded by the lane's `maxWaitMs`) for a slot to free. The server must
 * call `release()` when an authorized request finishes; that frees the slot and
 * admits the next queued request in band order.
 */
export declare class PriorityLanePolicy {
    #private;
    constructor(scheduler: LaneScheduler, options?: PriorityLanePolicyOptions);
    authorize(principal: {
        tenantId: string;
        subject: string;
        lane?: string;
    }): Promise<void>;
    release(): void;
    pending(): readonly AdmissionRequest[];
    inFlight(): number;
}
