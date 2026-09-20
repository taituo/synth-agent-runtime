import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryHintMs } from "../src/retry-hints.js";

test("Retry-After seconds form", () => {
  assert.equal(parseRetryHintMs(new Headers({ "retry-after": "2" })), 2_000);
  assert.equal(parseRetryHintMs(new Headers({ "retry-after": "0" })), 0);
  assert.equal(parseRetryHintMs(new Headers({ "retry-after": "-5" })), -5_000, "negative survives for the workflow to clamp");
});

test("Retry-After HTTP-date form uses the Date header, not the local clock", () => {
  const serverNow = Date.parse("2026-09-20T12:00:00Z");
  const reset = new Date(serverNow + 5_000).toUTCString();
  const headers = new Headers({ "retry-after": reset, date: new Date(serverNow).toUTCString() });
  // Worker clock is wildly skewed; the hint must still be ~5000ms.
  assert.equal(parseRetryHintMs(headers, serverNow + 9_000_000), 5_000);
});

test("Retry-After HTTP-date without a Date header falls back to the provided now", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  const headers = new Headers({ "retry-after": new Date(now + 3_000).toUTCString() });
  assert.equal(parseRetryHintMs(headers, now), 3_000);
});

test("x-ratelimit-reset: epoch seconds, epoch ms, and seconds-from-now", () => {
  const serverNow = Date.parse("2026-09-20T12:00:00Z");
  const date = new Date(serverNow).toUTCString();
  const epochSeconds = Math.floor((serverNow + 30_000) / 1000);
  assert.equal(parseRetryHintMs(new Headers({ "x-ratelimit-reset": String(epochSeconds), date }), serverNow), 30_000);
  assert.equal(parseRetryHintMs(new Headers({ "x-ratelimit-reset": String(serverNow + 30_000), date }), serverNow), 30_000);
  assert.equal(parseRetryHintMs(new Headers({ "x-ratelimit-reset": "45" }), serverNow), 45_000, "seconds from now");
  // Alternate spellings.
  assert.equal(parseRetryHintMs(new Headers({ "x-rate-limit-reset": "45" })), 45_000);
  assert.equal(parseRetryHintMs(new Headers({ "ratelimit-reset": "45" })), 45_000);
});

test("absent and garbage hints return undefined", () => {
  assert.equal(parseRetryHintMs(new Headers()), undefined);
  assert.equal(parseRetryHintMs(new Headers({ "retry-after": "soon" })), undefined);
  assert.equal(parseRetryHintMs(new Headers({ "x-ratelimit-reset": "not-a-number" })), undefined);
  assert.equal(parseRetryHintMs(new Headers({ "retry-after": "" })), undefined);
});

test("Retry-After wins over ratelimit-reset", () => {
  const headers = new Headers({ "retry-after": "3", "x-ratelimit-reset": "60" });
  assert.equal(parseRetryHintMs(headers), 3_000);
});
