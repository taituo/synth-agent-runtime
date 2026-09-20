export class LaneScheduler {
    #lanes;
    #capacity;
    #now;
    #defaultLane;
    #estimatedServiceMs;
    #inFlight = 0;
    #queue = [];
    #sequence = 0;
    // Deficit weighted round-robin state per lane (piece 2): weight is credited
    // on each decision within a band and the winner is debited the active total,
    // so a lane's share tracks its weight without starving the others.
    #deficit = new Map();
    // Reservation credit for lower bands: accrues `#reserveFraction` per admission
    // granted to a higher band and spends 1 when a lower band is admitted, so over
    // time a lower band with demand receives ~`#reserveFraction` of admissions.
    #reserveFraction;
    #reserveCredit = 0;
    constructor(lanes, options) {
        if (lanes.length === 0)
            throw new Error("LaneScheduler requires at least one lane");
        if (!Number.isInteger(options.capacity) || options.capacity < 1)
            throw new Error(`Invalid capacity: ${options.capacity}`);
        this.#lanes = new Map();
        for (const lane of lanes) {
            if (this.#lanes.has(lane.id))
                throw new Error(`Duplicate lane: ${lane.id}`);
            this.#lanes.set(lane.id, lane);
        }
        this.#capacity = options.capacity;
        this.#now = options.now ?? Date.now;
        const fallback = [...lanes].sort((a, b) => a.priority - b.priority)[0];
        this.#defaultLane = options.defaultLane ?? fallback.id;
        if (!this.#lanes.has(this.#defaultLane))
            throw new Error(`Unknown default lane: ${this.#defaultLane}`);
        this.#estimatedServiceMs = Math.max(0, options.estimatedServiceMs ?? 1_000);
        const reserve = options.lowerBandReserveFraction ?? 0.2;
        this.#reserveFraction = Number.isFinite(reserve) ? Math.max(0, Math.min(1, reserve)) : 0.2;
    }
    /** Admit now, enqueue with a bounded wait, or reject. */
    admit(request) {
        const lane = this.#lanes.get(request.lane) ?? this.#lanes.get(this.#defaultLane);
        if (!lane)
            return { outcome: "reject", reason: "unknown-lane", retryAfterMs: 0 };
        if (this.#inFlight < this.#capacity) {
            this.#inFlight++;
            return { outcome: "admit" };
        }
        if (lane.maxWaitMs <= 0)
            return { outcome: "reject", reason: "lane-full", retryAfterMs: 0 };
        const ticket = `t${++this.#sequence}`;
        this.#queue.push({ ticket, request, enqueuedAt: this.#now() });
        // Estimated wait: everything already queued ahead of this request.
        const retryAfterMs = Math.max(0, this.#queue.length - 1) * this.#estimatedServiceMs;
        return { outcome: "queue", retryAfterMs, ticket };
    }
    /**
     * Reject queued requests that have waited longer than their lane allows.
     * Returns them with `reason: "deadline"` so the caller can propagate a
     * `Retry-After`. The scheduler's own clock is authoritative (open question 7).
     */
    expire(at = this.#now()) {
        const expired = [];
        const remaining = [];
        for (const entry of this.#queue) {
            const lane = this.#lanes.get(entry.request.lane) ?? this.#lanes.get(this.#defaultLane);
            if (lane.maxWaitMs > 0 && at - entry.enqueuedAt > lane.maxWaitMs) {
                expired.push({ request: entry.request, reason: "deadline", retryAfterMs: 0 });
            }
            else {
                remaining.push(entry);
            }
        }
        this.#queue = remaining;
        return expired;
    }
    /**
     * Free one slot and hand back the next queued request to run: the highest
     * band first, so an interactive request never waits behind batch work. The
     * caller is responsible for honouring the returned request (or calling
     * `release` again if it was cancelled).
     */
    release() {
        if (this.#inFlight > 0)
            this.#inFlight--;
        const next = this.#takeNext();
        if (next)
            this.#inFlight++;
        return next ? { ticket: next.ticket, request: next.request } : undefined;
    }
    /** Drop a queued request (e.g. its waiter gave up). Returns whether it was queued. */
    cancel(ticket) {
        const index = this.#queue.findIndex((entry) => entry.ticket === ticket);
        if (index < 0)
            return false;
        this.#queue.splice(index, 1);
        return true;
    }
    #takeNext() {
        if (this.#queue.length === 0)
            return undefined;
        // Never admit a request that has already passed its lane deadline, even
        // when release() is called directly (S6). The policy's timer also cancels
        // such tickets, but the scheduler's own guarantee must hold on its own.
        const now = this.#now();
        this.#queue = this.#queue.filter((entry) => {
            const lane = this.#lanes.get(entry.request.lane) ?? this.#lanes.get(this.#defaultLane);
            return !(lane.maxWaitMs > 0 && now - entry.enqueuedAt > lane.maxWaitMs);
        });
        if (this.#queue.length === 0)
            return undefined;
        const priorityOf = (entry) => this.#lanes.get(entry.request.lane)?.priority ?? 0;
        const maxPriority = Math.max(...this.#queue.map(priorityOf));
        const top = this.#queue.filter((entry) => priorityOf(entry) === maxPriority);
        const lower = this.#queue.filter((entry) => priorityOf(entry) < maxPriority);
        // Band first, with a reservation: when a lower band has demand and the
        // reservation is owed, admit from the lower bands even though a higher band
        // is backlogged. Otherwise admit from the highest band and accrue credit.
        let group;
        if (top.length === 0) {
            group = lower;
        }
        else if (lower.length > 0 && this.#reserveCredit >= 1) {
            group = lower;
        }
        else {
            group = top;
        }
        // Credit accrues on EVERY admission and is spent on a reserved one, so over
        // time a backlogged lower band receives ~`#reserveFraction` of admissions.
        if (group === lower && top.length > 0)
            this.#reserveCredit -= 1;
        this.#reserveCredit = Math.min(1, this.#reserveCredit + this.#reserveFraction);
        const chosen = this.#pickWeighted(group);
        return this.#queue.splice(this.#queue.indexOf(chosen), 1)[0];
    }
    /** Weighted fair-share (deficit round-robin) across the lanes present in `entries`. */
    #pickWeighted(entries) {
        const weightOf = (lane) => {
            const weight = this.#lanes.get(lane)?.weight ?? 1;
            return Number.isFinite(weight) && weight > 0 ? weight : 1;
        };
        // Ties go to the lane whose earliest queued request arrived first (FIFO).
        const firstIndex = (lane) => entries.findIndex((entry) => entry.request.lane === lane);
        const activeLanes = [...new Set(entries.map((entry) => entry.request.lane))];
        const totalWeight = activeLanes.reduce((sum, lane) => sum + weightOf(lane), 0);
        for (const lane of activeLanes)
            this.#deficit.set(lane, (this.#deficit.get(lane) ?? 0) + weightOf(lane));
        let bestLane = activeLanes[0];
        for (const lane of activeLanes) {
            const deficit = this.#deficit.get(lane) ?? 0;
            const bestDeficit = this.#deficit.get(bestLane) ?? 0;
            if (deficit > bestDeficit || (deficit === bestDeficit && firstIndex(lane) < firstIndex(bestLane))) {
                bestLane = lane;
            }
        }
        this.#deficit.set(bestLane, (this.#deficit.get(bestLane) ?? 0) - totalWeight);
        return entries.find((entry) => entry.request.lane === bestLane);
    }
    pending() {
        return this.#queue.map((entry) => entry.request);
    }
    inFlight() {
        return this.#inFlight;
    }
    lane(id) {
        return this.#lanes.get(id);
    }
}
/** An admission failure that carries the server's `Retry-After` hint in ms. */
export function laneError(reason, retryAfterMs) {
    const error = new Error(`LANE_${reason.toUpperCase()}: retry after ${retryAfterMs}ms`);
    error.retryAfterMs = retryAfterMs;
    error.laneReason = reason;
    return error;
}
/**
 * Gateway policy that admits requests through a {@link LaneScheduler}.
 *
 * `authorize` either admits immediately, rejects with a `Retry-After` hint, or
 * waits (bounded by the lane's `maxWaitMs`) for a slot to free. The server must
 * call `release()` when an authorized request finishes; that frees the slot and
 * admits the next queued request in band order.
 */
export class PriorityLanePolicy {
    #scheduler;
    #defaultLane;
    #now;
    #waiters = new Map();
    constructor(scheduler, options = {}) {
        this.#scheduler = scheduler;
        this.#defaultLane = options.defaultLane ?? "batch";
        this.#now = options.now ?? Date.now;
    }
    async authorize(principal) {
        const lane = principal.lane ?? this.#defaultLane;
        const decision = this.#scheduler.admit({ lane, tenantId: principal.tenantId, key: principal.subject, at: this.#now() });
        if (decision.outcome === "admit")
            return;
        if (decision.outcome === "reject")
            throw laneError(decision.reason, decision.retryAfterMs);
        // An unknown lane is queued under the default lane by `admit`, so its
        // deadline must come from the default lane too, not from a missing lane
        // (which would fire a 1 ms deadline) (S7).
        const spec = this.#scheduler.lane(lane) ?? this.#scheduler.lane(this.#defaultLane);
        const maxWaitMs = spec?.maxWaitMs ?? 0;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#waiters.delete(decision.ticket);
                this.#scheduler.cancel(decision.ticket);
                reject(laneError("deadline", maxWaitMs));
            }, Math.max(1, maxWaitMs));
            // Deliberately NOT unref'd: this timer is what rejects a queued request
            // whose deadline passes, so it must fire even if nothing else keeps the
            // loop alive.
            this.#waiters.set(decision.ticket, { resolve: () => { clearTimeout(timer); resolve(); } });
        });
    }
    release() {
        const next = this.#scheduler.release();
        if (!next)
            return;
        const waiter = this.#waiters.get(next.ticket);
        if (waiter) {
            this.#waiters.delete(next.ticket);
            waiter.resolve();
        }
    }
    pending() {
        return this.#scheduler.pending();
    }
    inFlight() {
        return this.#scheduler.inFlight();
    }
}
