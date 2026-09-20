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
  assert.equal(scheduler.release()?.key, "high-late");
  assert.equal(scheduler.release()?.key, "low-early");
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

test("constructor rejects bad configuration", () => {
  assert.throws(() => new LaneScheduler([], { capacity: 1 }), /at least one lane/);
  assert.throws(() => new LaneScheduler(LANES, { capacity: 0 }), /Invalid capacity/);
  assert.throws(() => new LaneScheduler([LANES[0]!, LANES[0]!], { capacity: 1 }), /Duplicate lane/);
  assert.throws(() => new LaneScheduler(LANES, { capacity: 1, defaultLane: "missing" }), /Unknown default lane/);
});
