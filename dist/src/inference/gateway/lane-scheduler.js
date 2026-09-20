export class LaneScheduler {
    #lanes;
    #capacity;
    #now;
    #defaultLane;
    #inFlight = 0;
    #queue = [];
    #sequence = 0;
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
        return { outcome: "queue", retryAfterMs: 0, ticket };
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
        return next?.request;
    }
    #takeNext() {
        if (this.#queue.length === 0)
            return undefined;
        let best = 0;
        for (let i = 1; i < this.#queue.length; i++) {
            const candidate = this.#lanes.get(this.#queue[i].request.lane);
            const incumbent = this.#lanes.get(this.#queue[best].request.lane);
            const candidatePriority = candidate?.priority ?? 0;
            const incumbentPriority = incumbent?.priority ?? 0;
            if (candidatePriority > incumbentPriority)
                best = i;
            // Equal bands fall back to FIFO here; the fair-share piece replaces this
            // with weighted selection.
        }
        return this.#queue.splice(best, 1)[0];
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
