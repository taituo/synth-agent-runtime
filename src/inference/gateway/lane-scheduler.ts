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

export type AdmissionDecision =
  | { outcome: "admit" }
  | { outcome: "queue"; retryAfterMs: number; ticket: string }
  | { outcome: "reject"; reason: AdmissionRejection; retryAfterMs: number };

export interface LaneSchedulerOptions {
  /** Concurrent admissions allowed before requests queue or reject. */
  capacity: number;
  now?: () => number;
  /** Lane used when a request names an unknown lane; defaults to the lowest-priority lane. */
  defaultLane?: LaneId;
}

interface Queued {
  ticket: string;
  request: AdmissionRequest;
  enqueuedAt: number;
}

export class LaneScheduler {
  readonly #lanes: Map<LaneId, LaneSpec>;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #defaultLane: LaneId;
  #inFlight = 0;
  #queue: Queued[] = [];
  #sequence = 0;
  // Deficit weighted round-robin state per lane (piece 2): weight is credited
  // on each decision within a band and the winner is debited the active total,
  // so a lane's share tracks its weight without starving the others.
  #deficit = new Map<LaneId, number>();

  constructor(lanes: readonly LaneSpec[], options: LaneSchedulerOptions) {
    if (lanes.length === 0) throw new Error("LaneScheduler requires at least one lane");
    if (!Number.isInteger(options.capacity) || options.capacity < 1) throw new Error(`Invalid capacity: ${options.capacity}`);
    this.#lanes = new Map();
    for (const lane of lanes) {
      if (this.#lanes.has(lane.id)) throw new Error(`Duplicate lane: ${lane.id}`);
      this.#lanes.set(lane.id, lane);
    }
    this.#capacity = options.capacity;
    this.#now = options.now ?? Date.now;
    const fallback = [...lanes].sort((a, b) => a.priority - b.priority)[0]!;
    this.#defaultLane = options.defaultLane ?? fallback.id;
    if (!this.#lanes.has(this.#defaultLane)) throw new Error(`Unknown default lane: ${this.#defaultLane}`);
  }

  /** Admit now, enqueue with a bounded wait, or reject. */
  admit(request: AdmissionRequest): AdmissionDecision {
    const lane = this.#lanes.get(request.lane) ?? this.#lanes.get(this.#defaultLane);
    if (!lane) return { outcome: "reject", reason: "unknown-lane", retryAfterMs: 0 };
    if (this.#inFlight < this.#capacity) {
      this.#inFlight++;
      return { outcome: "admit" };
    }
    if (lane.maxWaitMs <= 0) return { outcome: "reject", reason: "lane-full", retryAfterMs: 0 };
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
  release(): AdmissionRequest | undefined {
    if (this.#inFlight > 0) this.#inFlight--;
    const next = this.#takeNext();
    if (next) this.#inFlight++;
    return next?.request;
  }

  #takeNext(): Queued | undefined {
    if (this.#queue.length === 0) return undefined;
    const priorityOf = (entry: Queued): number => this.#lanes.get(entry.request.lane)?.priority ?? 0;
    const weightOf = (lane: LaneId): number => {
      const weight = this.#lanes.get(lane)?.weight ?? 1;
      return Number.isFinite(weight) && weight > 0 ? weight : 1;
    };

    // Band first: only the highest priority band is eligible this round.
    const maxPriority = Math.max(...this.#queue.map(priorityOf));
    const band = this.#queue.filter((entry) => priorityOf(entry) === maxPriority);
    const activeLanes = [...new Set(band.map((entry) => entry.request.lane))];

    // Weighted fair-share across the lanes in the band (deficit round-robin).
    const totalWeight = activeLanes.reduce((sum, lane) => sum + weightOf(lane), 0);
    for (const lane of activeLanes) this.#deficit.set(lane, (this.#deficit.get(lane) ?? 0) + weightOf(lane));
    let bestLane = activeLanes[0]!;
    for (const lane of activeLanes) {
      const deficit = this.#deficit.get(lane) ?? 0;
      const bestDeficit = this.#deficit.get(bestLane) ?? 0;
      // Ties go to the lane whose earliest queued request arrived first (FIFO).
      if (deficit > bestDeficit || (deficit === bestDeficit && this.#firstIndex(lane) < this.#firstIndex(bestLane))) {
        bestLane = lane;
      }
    }
    this.#deficit.set(bestLane, (this.#deficit.get(bestLane) ?? 0) - totalWeight);

    const index = this.#queue.findIndex((entry) => entry.request.lane === bestLane);
    return this.#queue.splice(index, 1)[0];
  }

  #firstIndex(lane: LaneId): number {
    return this.#queue.findIndex((entry) => entry.request.lane === lane);
  }

  pending(): readonly AdmissionRequest[] {
    return this.#queue.map((entry) => entry.request);
  }

  inFlight(): number {
    return this.#inFlight;
  }

  lane(id: LaneId): LaneSpec | undefined {
    return this.#lanes.get(id);
  }
}
