import test from "node:test";
import assert from "node:assert/strict";
import { honoursRetryHint } from "../src/park-tracking.js";

test("a park at least as long as the hint counts", () => {
  assert.equal(honoursRetryHint({ longestWaitMs: 2_500, hintMs: 2_000, toleranceMs: 1_500 }), true);
});

test("a blind backoff shorter than the hint does not count", () => {
  // This is the discriminating case: a fixed backoff also parks, but not for
  // the server's window. The old driver's `parked` flag passed on this.
  assert.equal(honoursRetryHint({ longestWaitMs: 400, hintMs: 2_000, toleranceMs: 1_500 }), false);
});

test("a missing, zero or negative hint never counts", () => {
  assert.equal(honoursRetryHint({ longestWaitMs: 99_999, hintMs: undefined, toleranceMs: 0 }), false);
  assert.equal(honoursRetryHint({ longestWaitMs: 99_999, hintMs: 0, toleranceMs: 0 }), false);
  assert.equal(honoursRetryHint({ longestWaitMs: 99_999, hintMs: -1, toleranceMs: 0 }), false);
});
