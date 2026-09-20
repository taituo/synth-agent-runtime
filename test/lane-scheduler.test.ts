/**
 * Priority-lane scheduler, piece 1: lane model, band ordering, queue-or-reject.
 * Pure and fake-clock, so these are real behavioural assertions (the band
 * ordering is asserted by WHO is released, not by a status string).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LaneScheduler, type LaneSpec } from "../src/index.js";

const LANES: LaneSpec[] = [
  { id: "interactive", priority: 10, weight: 1, maxWaitMs: 5_000 },
  { id: "batch", priority: 5, weight: 1, maxWaitMs: 60_000 },
  { id: "fire-and-forget", priority: 1, weight: 1, maxWaitMs: 0 },
];

function request(lane: string, key = lane) {
  return { lane, tenantId: "t1", key, at: 0 };
}

test("admits while there is capacity", () => {
  const scheduler = new LaneScheduler(LANES, { capacity: 2 });
  assert.deepEqual(scheduler.admit(request("batch")), { outcome: "admit" });
  assert.deepEqual(scheduler.admit(request("interactive")), { outcome: "admit" });
  assert.equal(scheduler.inFlight(), 2);
});

test("queues with a ticket once full, and lists it as pending", () => {
  const scheduler = new LaneScheduler(LANES, { capacity: 1 });
  scheduler.admit(request("batch", "first"));
  const decision = scheduler.admit(request("batch", "second"));
  assert.equal(decision.outcome, "queue");
  assert.equal(typeof (decision as { ticket: string }).ticket, "string");
  assert.deepEqual(scheduler.pending().map((entry) => entry.key), ["second"]);
});

test("a lane that may never queue rejects when full", () => {
  const scheduler = new LaneScheduler(LANES, { capacity: 1 });
  scheduler.admit(request("batch"));
  assert.deepEqual(scheduler.admit(request("fire-and-forget")), { outcome: "reject", reason: "lane-full", retryAfterMs: 0 });
});

test("band ordering: release picks the highest band, not the earliest arrival", () => {
  const scheduler = new LaneScheduler(LANES, { capacity: 1 });
  assert.deepEqual(scheduler.admit(request("batch", "in-flight")), { outcome: "admit" });
  scheduler.admit(request("batch", "low-early"));
  scheduler.admit(request("interactive", "high-late"));
  // Freeing the slot must admit the interactive request first.
  assert.equal(scheduler.release()?.request.key, "high-late");
  assert.equal(scheduler.release()?.request.key, "low-early");
  assert.equal(scheduler.release(), undefined);
});

test("an unknown lane falls back to the default (lowest-priority) lane", () => {
  const scheduler = new LaneScheduler(LANES, { capacity: 1 });
  // Default is the lowest-priority lane (fire-and-forget, maxWaitMs 0).
  assert.deepEqual(scheduler.admit(request("nonsense")), { outcome: "admit" });
  assert.deepEqual(scheduler.admit(request("nonsense")), { outcome: "reject", reason: "lane-full", retryAfterMs: 0 });
});

test("a single lane with capacity behaves like the old path under capacity", () => {
  const scheduler = new LaneScheduler([{ id: "default", priority: 1, weight: 1, maxWaitMs: 0 }], { capacity: 3 });
  for (let i = 0; i < 3; i++) assert.deepEqual(scheduler.admit(request("default", `k${i}`)), { outcome: "admit" });
  assert.deepEqual(scheduler.admit(request("default", "over")), { outcome: "reject", reason: "lane-full", retryAfterMs: 0 });
});

test("weighted fair-share within a band tracks the configured weights", () => {
  const lanes: LaneSpec[] = [
    { id: "heavy", priority: 5, weight: 3, maxWaitMs: 60_000 },
    { id: "light", priority: 5, weight: 1, maxWaitMs: 60_000 },
  ];
  const scheduler = new LaneScheduler(lanes, { capacity: 1 });
  scheduler.admit(request("heavy", "seed")); // occupy the single slot
  scheduler.admit(request("heavy", "h0"));
  scheduler.admit(request("light", "l0"));
  // Sustain contention: replenish whichever lane was just admitted, so both
  // lanes always have a queued request and the ratio reflects the weights
  // rather than which finite backlog drained first.
  const admitted: Record<string, number> = { heavy: 0, light: 0 };
  for (let i = 0; i < 400; i++) {
    const next = scheduler.release();
    if (!next) break;
    admitted[next.request.lane] = (admitted[next.request.lane] ?? 0) + 1;
    scheduler.admit(request(next.request.lane, `${next.request.lane}-${i}`));
  }
  const ratio = admitted.heavy! / admitted.light!;
  assert.ok(ratio > 2.4 && ratio < 3.6, `expected ~3:1, got ${admitted.heavy}:${admitted.light}`);
});

test("band priority beats weight: a heavy low band waits behind a light high band", () => {
  const lanes: LaneSpec[] = [
    { id: "high", priority: 10, weight: 1, maxWaitMs: 60_000 },
    { id: "low", priority: 1, weight: 100, maxWaitMs: 60_000 },
  ];
  const scheduler = new LaneScheduler(lanes, { capacity: 1 });
  scheduler.admit(request("high", "seed"));
  scheduler.admit(request("low", "low1"));
  scheduler.admit(request("high", "high1"));
  assert.equal(scheduler.release()?.request.lane, "high");
});

test("a queued request reports an estimated Retry-After", () => {
  const scheduler = new LaneScheduler(LANES, { capacity: 1, estimatedServiceMs: 1_000 });
  scheduler.admit(request("batch", "seed"));
  const first = scheduler.admit(request("batch", "q1"));
  assert.equal(first.outcome, "queue");
  assert.equal((first as { retryAfterMs: number }).retryAfterMs, 0, "nothing queued ahead");
  const second = scheduler.admit(request("batch", "q2"));
  assert.equal((second as { retryAfterMs: number }).retryAfterMs, 1_000, "one request ahead");
});

test("a queued request past its lane deadline is rejected, not admitted", () => {
  let now = 1_000;
  const scheduler = new LaneScheduler(LANES, { capacity: 1, now: () => now });
  scheduler.admit(request("interactive", "seed")); // occupies the slot
  scheduler.admit(request("interactive", "waiting")); // maxWaitMs 5000
  now += 4_000;
  assert.deepEqual(scheduler.expire(), [], "still within the deadline");
  now += 2_000; // 6000 > 5000
  const expired = scheduler.expire();
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.reason, "deadline");
  assert.equal(expired[0]!.request.key, "waiting");
  assert.equal(scheduler.pending().length, 0);
});

test("constructor rejects bad configuration", () => {
  assert.throws(() => new LaneScheduler([], { capacity: 1 }), /at least one lane/);
  assert.throws(() => new LaneScheduler(LANES, { capacity: 0 }), /Invalid capacity/);
  assert.throws(() => new LaneScheduler([LANES[0]!, LANES[0]!], { capacity: 1 }), /Duplicate lane/);
  assert.throws(() => new LaneScheduler(LANES, { capacity: 1, defaultLane: "missing" }), /Unknown default lane/);
});
