import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryHintMs } from "../src/retry-hints.js";
import { parseRetryAfterMs } from "../../pi-opencode-stack-router/src/inference/retry-after.js";

/**
 * The stack-router is a separate package and keeps a standalone copy of the
 * parser. This feeds both the same header sets and asserts they agree, so the
 * two implementations cannot drift apart silently. Each case also pins the
 * expected value, so agreement on a wrong answer is not enough.
 */
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const DATE = new Date(NOW).toUTCString();

function record(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
}

const CASES: Array<{ name: string; headers: Record<string, string>; expected: number | undefined }> = [
  { name: "retry-after seconds", headers: { "retry-after": "2" }, expected: 2_000 },
  { name: "retry-after zero", headers: { "retry-after": "0" }, expected: 0 },
  { name: "retry-after negative survives for the caller to clamp", headers: { "retry-after": "-5" }, expected: -5_000 },
  { name: "retry-after http date", headers: { "retry-after": new Date(NOW + 3_000).toUTCString() }, expected: 3_000 },
  { name: "retry-after garbage", headers: { "retry-after": "soon" }, expected: undefined },
  { name: "retry-after empty", headers: { "retry-after": "" }, expected: undefined },
  { name: "ratelimit-reset epoch seconds", headers: { "x-ratelimit-reset": String(Math.floor((NOW + 30_000) / 1000)), date: DATE }, expected: 30_000 },
  { name: "ratelimit-reset epoch ms", headers: { "x-ratelimit-reset": String(NOW + 30_000), date: DATE }, expected: 30_000 },
  { name: "ratelimit-reset seconds from now", headers: { "x-ratelimit-reset": "45" }, expected: 45_000 },
  { name: "x-rate-limit-reset spelling", headers: { "x-rate-limit-reset": "45" }, expected: 45_000 },
  { name: "ratelimit-reset spelling", headers: { "ratelimit-reset": "45" }, expected: 45_000 },
  { name: "retry-after wins over ratelimit-reset", headers: { "retry-after": "3", "x-ratelimit-reset": "60" }, expected: 3_000 },
  { name: "no headers", headers: {}, expected: undefined },
];

for (const testCase of CASES) {
  test(`canonical and stack-router agree: ${testCase.name}`, () => {
    const headers = new Headers(testCase.headers);
    const canonical = parseRetryHintMs(headers, NOW);
    const stackRouter = parseRetryAfterMs(record(headers), NOW);
    assert.equal(canonical, testCase.expected, `canonical value for ${testCase.name}`);
    assert.equal(stackRouter, canonical, `stack-router drifted from canonical on ${testCase.name}`);
  });
}
