/**
 * S1: PriorityLanePolicy and CompositeTenantPolicy. The spec mandates composing
 * the lane policy via CompositeTenantPolicy; the composite must forward
 * `release` (or lane slots leak) and must release an already-authorized policy
 * when a later one throws.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CompositeTenantPolicy,
  LaneScheduler,
  PriorityLanePolicy,
  type GatewayPrincipal,
  type GatewayTenantPolicy,
} from "../src/index.js";

const LANES = [
  { id: "interactive", priority: 10, weight: 1, maxWaitMs: 5_000 },
  { id: "batch", priority: 1, weight: 1, maxWaitMs: 5_000 },
];

function principal(subject: string, lane: string): GatewayPrincipal {
  return { tenantId: "t1", subject, lane };
}

test("PriorityLanePolicy admits under capacity and release frees the slot", async () => {
  const scheduler = new LaneScheduler(LANES, { capacity: 1 });
  const policy = new PriorityLanePolicy(scheduler, { defaultLane: "batch" });
  await policy.authorize(principal("A", "batch"));
  assert.equal(scheduler.inFlight(), 1);
  policy.release();
  assert.equal(scheduler.inFlight(), 0);
});

test("a queued request resolves on release, highest band first", async () => {
  const scheduler = new LaneScheduler(LANES, { capacity: 1 });
  const policy = new PriorityLanePolicy(scheduler, { defaultLane: "batch" });
  await policy.authorize(principal("seed", "batch")); // occupies the slot

  const resolved: string[] = [];
  const b = policy.authorize(principal("B", "batch")).then(() => resolved.push("B"));
  const c = policy.authorize(principal("C", "interactive")).then(() => resolved.push("C"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(resolved, [], "both queued");

  policy.release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(resolved, ["C"], "interactive overtakes the earlier batch request");
  policy.release();
  await Promise.all([b, c]);
  assert.deepEqual(resolved, ["C", "B"]);
});

test("a request past its lane deadline rejects with a Retry-After", async () => {
  const scheduler = new LaneScheduler([{ id: "short", priority: 1, weight: 1, maxWaitMs: 20 }], { capacity: 1 });
  const policy = new PriorityLanePolicy(scheduler, { defaultLane: "short" });
  await policy.authorize(principal("seed", "short"));
  await assert.rejects(
    policy.authorize(principal("q", "short")),
    (error: unknown) => {
      assert.match(String(error), /LANE_DEADLINE/);
      assert.equal((error as { retryAfterMs?: number }).retryAfterMs, 20);
      return true;
    },
  );
});

test("CompositeTenantPolicy forwards release to every sub-policy", async () => {
  const spies: GatewayTenantPolicy[] = [];
  const spy = () => {
    const policy: GatewayTenantPolicy & { released: number } = {
      released: 0,
      authorize() {},
      release() {
        policy.released++;
      },
    };
    spies.push(policy);
    return policy;
  };
  const first = spy();
  const second = spy();
  const composite = new CompositeTenantPolicy([first, second]);
  await composite.authorize(principal("s", "batch"), "model");
  await composite.release(principal("s", "batch"));
  assert.equal((first as { released: number }).released, 1);
  assert.equal((second as { released: number }).released, 1);
});

test("CompositeTenantPolicy releases an earlier admission when a later policy throws", async () => {
  const scheduler = new LaneScheduler([{ id: "batch", priority: 1, weight: 1, maxWaitMs: 5_000 }], { capacity: 1 });
  const lane = new PriorityLanePolicy(scheduler, { defaultLane: "batch" });
  const boom: GatewayTenantPolicy = {
    authorize() {
      throw new Error("RATE_LIMITED:t1");
    },
  };
  const composite = new CompositeTenantPolicy([lane, boom]);
  await assert.rejects(composite.authorize(principal("s", "batch"), "model"), /RATE_LIMITED/);
  assert.equal(scheduler.inFlight(), 0, "lane slot must not leak when a later policy throws");
});
