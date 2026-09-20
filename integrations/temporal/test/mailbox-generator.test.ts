import test from "node:test";
import assert from "node:assert/strict";
import {
  batchProperty,
  boundedTurns,
  firstConsumptionOrder,
  generateReturnStates,
  generateStream,
  mulberry32,
  shrinkPrefix,
} from "../mailbox-generator.js";

test("the generator is deterministic from a seed", () => {
  const a = generateStream(42, { size: 12, pattern: "bursty" });
  const b = generateStream(42, { size: 12, pattern: "bursty" });
  assert.deepEqual(a, b, "same seed => same stream");
  const c = generateStream(43, { size: 12, pattern: "bursty" });
  assert.notDeepEqual(a.map((e) => e.text), c.map((e) => e.text), "different seed => different stream");
  // PRNG in range
  const random = mulberry32(7);
  for (let i = 0; i < 100; i++) {
    const value = random();
    assert.ok(value >= 0 && value < 1);
  }
});

test("arrival patterns shape the delays", () => {
  const herd = generateStream(1, { size: 10, pattern: "herd" });
  assert.equal(herd[0]!.delayMs, 0);
  assert.ok(herd.slice(1).every((event) => event.delayMs === 0), "herd: all at once");
  const steady = generateStream(1, { size: 10, pattern: "steady" });
  assert.ok(steady.slice(1).every((event) => event.delayMs === 120), "steady: constant gap");
  const bursty = generateStream(1, { size: 20, pattern: "bursty" });
  assert.ok(new Set(bursty.slice(1).map((event) => event.delayMs)).size > 1, "bursty: mixed gaps");
});

test("generated text varies in length, including empty-ish", () => {
  const stream = generateStream(9, { size: 60, pattern: "steady", maxTextLength: 120 });
  const lengths = new Set(stream.map((event) => event.text.length));
  assert.ok(lengths.size > 3, "varied lengths");
  assert.ok(stream.some((event) => event.text.length === 0 || event.text.trim() === ""), "some empty-ish events");
});

test("batchProperty accepts an exact, ordered concatenation", () => {
  const ids = ["a", "b", "c", "d"];
  assert.equal(batchProperty(ids, [["a"], ["b", "c"], ["d"]]).ok, true);
  assert.equal(batchProperty(ids, [["a", "b", "c", "d"]]).ok, true);
});

test("batchProperty rejects loss, duplication and reordering", () => {
  const ids = ["a", "b", "c", "d"];
  assert.match(batchProperty(ids, [["a"], ["b"], ["d"]]).reason ?? "", /batched 3 of 4/);
  assert.match(batchProperty(ids, [["a", "b", "c", "d", "e"]]).reason ?? "", /batched 5 of 4/);
  assert.match(batchProperty(ids, [["a", "c", "b", "d"]]).reason ?? "", /order mismatch at 1/);
  assert.match(batchProperty(ids, [["a", "b", "b", "d"]]).reason ?? "", /order mismatch at 2/);
});

test("regression: the shrinker's minimal lossy repros stay detected", () => {
  // Failing-first run (mailbox mutation dropping mid-turn arrivals) shrank to
  // these minimal streams for seed 1; pin that a run losing everything after
  // the first batch is always rejected.
  const repros: Array<[pattern: "steady" | "bursty" | "herd", size: number]> = [
    ["steady", 2],
    ["bursty", 2],
    ["herd", 4],
  ];
  for (const [pattern, size] of repros) {
    const ids = generateStream(1, { size, pattern }).map((event) => event.id);
    const result = batchProperty(ids, [ids.slice(0, 1)]);
    assert.equal(result.ok, false, `${pattern}/${size}: loss must be detected`);
    assert.match(result.reason ?? "", /batched 1 of/);
  }
});

test("generateReturnStates is deterministic, seeded, and includes deferrals", () => {
  const a = generateReturnStates(7, 16, 4);
  const b = generateReturnStates(7, 16, 4);
  assert.deepEqual(a, b, "same seed => same return states");
  assert.equal(a.length, 16);
  assert.ok(a.includes("waiting"), "at least one deferral");
  assert.ok(a.includes("idle"));
  assert.notDeepEqual(generateReturnStates(8, 16, 4), a, "different seed => different positions");
});

test("firstConsumptionOrder collapses a deferred turn's repeated prefix", () => {
  // Turn 1 returns "waiting" (messages not consumed); turn 2 re-runs them.
  const batches = [["a", "b"], ["a", "b"], ["a", "b", "c"], ["d"]];
  assert.deepEqual(firstConsumptionOrder(batches), ["a", "b", "c", "d"]);
});

test("boundedTurns rejects a spinning run and accepts a deferred one", () => {
  const normal = [["a"], ["a"], ["a", "b"], ["a", "b", "c"]];
  assert.equal(boundedTurns(normal, 3, 1), true);
  // 500 turns for 3 inputs is a spin, not legitimate deferral.
  const spin = Array.from({ length: 500 }, () => ["a"]);
  assert.equal(boundedTurns(spin, 3, 1), false);
});

test("shrinkPrefix reduces a failing stream to a minimal prefix", async () => {
  const stream = ["a", "b", "c", "d", "e"];
  // fails only once the candidate reaches length 3
  const minimal = await shrinkPrefix(stream, async (candidate) => candidate.length >= 3);
  assert.deepEqual(minimal, ["a", "b", "c"]);
  // never fails => whole stream returned
  assert.deepEqual(await shrinkPrefix(stream, async () => false), stream);
});
