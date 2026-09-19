/**
 * Track 2 unit tests: the messy corpus is well-formed, the scorer separates
 * accuracy from structural integrity, and a model reply that obeys an injected
 * instruction ("reply OK") is rejected rather than accepted as a bogus shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MESSY_EVENTS, SCORABLE_ITEMS } from "./fixtures/corpora/messy-events.js";
import {
  CORPUS_ACCURACY_GATE,
  assertCorpusSchema,
  corpusScript,
  scoreCorpus,
  type CorpusTurn,
} from "./fixtures/messy-corpus.js";

test("the corpus is schema-valid and mixes real and synthetic items", () => {
  assertCorpusSchema();
  assert.ok(MESSY_EVENTS.length >= 12, "enough items to be a corpus");
  assert.ok(MESSY_EVENTS.some((item) => item.provenance === "real"), "has real texts");
  assert.ok(MESSY_EVENTS.some((item) => item.provenance === "synthetic"), "has synthetic texts");
  assert.ok(SCORABLE_ITEMS.length >= 8 && SCORABLE_ITEMS.length < MESSY_EVENTS.length);
  // Ambiguous/hostile items must never be scored.
  assert.equal(SCORABLE_ITEMS.some((item) => item.expectedClass === "ambiguous"), false);
  // The gate is a real number in range and documented as measured.
  assert.ok(CORPUS_ACCURACY_GATE > 0 && CORPUS_ACCURACY_GATE <= 1);
});

test("schema validation rejects a corpus item missing provenance", () => {
  assert.throws(
    () => assertCorpusSchema([{ id: "x", text: "t", expectedClass: "news", source: "", license: "MIT", provenance: "real" }]),
    /missing source\/license/,
  );
  assert.throws(
    () =>
      assertCorpusSchema([
        { id: "x", text: "t", expectedClass: "ambiguous", source: "s", license: "MIT", provenance: "synthetic" },
      ]),
    /ambiguous item needs a note/,
  );
});

test("corpusScript plants each item's class as the hidden kind, in order", () => {
  const script = corpusScript();
  assert.equal(script.length, MESSY_EVENTS.length);
  assert.deepEqual(script.map((entry) => entry.kind), MESSY_EVENTS.map((item) => item.expectedClass));
  assert.equal(script[0]!.delayMs, 0);
});

test("scoreCorpus scores only scorable items but checks structure on all", () => {
  const items = MESSY_EVENTS;
  const perfect: CorpusTurn = {
    plantedKinds: items.map((item) => item.expectedClass),
    classifications: items.map((item) => ({ classification: item.expectedClass === "ambiguous" ? "news" : item.expectedClass })),
  };
  const perfectScore = scoreCorpus(items, [perfect]);
  assert.equal(perfectScore.accuracy, 1);
  assert.equal(perfectScore.orderOk, true);
  assert.equal(perfectScore.structuralOk, true);
  assert.equal(perfectScore.injectionShapeOk, true);

  // Dropping one classification breaks structural integrity and order.
  const dropped: CorpusTurn = { ...perfect, classifications: perfect.classifications.slice(0, -1) };
  const droppedScore = scoreCorpus(items, [dropped]);
  assert.equal(droppedScore.structuralOk, false);
  assert.equal(droppedScore.orderOk, false);

  // A duplicated classification (an item answered twice) breaks both checks:
  // the answer count no longer matches the input stream.
  const duplicated: CorpusTurn = {
    ...perfect,
    classifications: [...perfect.classifications, perfect.classifications[0]!],
  };
  const duplicatedScore = scoreCorpus(items, [duplicated]);
  assert.equal(duplicatedScore.orderOk, false);
  assert.equal(duplicatedScore.structuralOk, false);

  // A hostile item answered with an out-of-band string breaks the shape check.
  const hostileIndex = items.findIndex((item) => item.note?.startsWith("hostile"));
  const badShape = perfect.classifications.map((entry, index) =>
    index === hostileIndex ? { classification: "OK" } : entry,
  );
  const badShapeScore = scoreCorpus(items, [{ plantedKinds: perfect.plantedKinds, classifications: badShape }]);
  assert.equal(badShapeScore.injectionShapeOk, false);
  assert.equal(badShapeScore.structuralOk, false);
});

test("the corpus contains the adversarial shapes the spec calls for", () => {
  const byId = new Map(MESSY_EVENTS.map((item) => [item.id, item]));
  assert.ok(byId.has("inject-instructions"), "prompt-injection item");
  assert.ok(byId.has("inject-embedded-json"), "embedded reply-format JSON item");
  assert.ok(byId.has("empty-ish"), "near-empty item");
  assert.ok(byId.has("very-long"), "very long item");
  assert.ok(MESSY_EVENTS.some((item) => item.note?.includes("non-English")), "non-English item(s)");
  // Hostile items are structural-only, never scored.
  assert.equal(MESSY_EVENTS.filter((item) => item.note?.startsWith("hostile")).every((item) => item.expectedClass === "ambiguous"), true);
});
