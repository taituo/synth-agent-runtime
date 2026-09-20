/**
 * Stage-one scoring is objective: reported findings are compared against the
 * planted ground truth, with ambiguous items scored outside the gate. These
 * tests are the contract for that comparison.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReportedFinding, scoreFindings, type ReportedFinding } from "../src/swarm/findings.js";
import { PLANTED_STREAM } from "../src/swarm/stream.js";

const perfect: ReportedFinding[] = [
  { kind: "incident", summary: "checkout 5xx escalation", evidence: ["inc-2"] },
  { kind: "slow-burn", summary: "search latency creeping", evidence: ["burn-1", "burn-5"] },
  { kind: "correlation", summary: "recommendations after v2.3 deploy", evidence: ["rel-1", "corr-1"] },
];

test("a correct set of findings recovers every planted signal", () => {
  const score = scoreFindings(PLANTED_STREAM, perfect);
  assert.equal(score.recovered, 3);
  assert.equal(score.recall, 1);
  assert.equal(score.spurious, 0);
  assert.equal(score.precision, 1);
});

test("the correlation requires BOTH sides; one side alone is not recovery", () => {
  const half = scoreFindings(PLANTED_STREAM, [
    { kind: "correlation", summary: "recommendations errors", evidence: ["corr-1"] },
  ]);
  assert.equal(half.recovered, 0);
  assert.equal(half.missedIds.includes("planted-correlation"), true);
});

test("reporting a decoy as a finding is a false positive, not a recovery", () => {
  const score = scoreFindings(PLANTED_STREAM, [
    { kind: "incident", summary: "marketing traffic spike", evidence: ["dec-1"] },
  ]);
  assert.equal(score.recovered, 0);
  assert.equal(score.decoyReports, 1);
  assert.equal(score.spurious, 1);
  assert.equal(score.precision, 0);
});

test("an ambiguous item is scored separately, not as a false positive", () => {
  const score = scoreFindings(PLANTED_STREAM, [
    { kind: "incident", summary: "latency above target", evidence: ["amb-1"] },
  ]);
  assert.equal(score.ambiguousReports, 1);
  assert.equal(score.spurious, 0);
  assert.equal(score.precision, 1);
});

test("missing one planted signal lowers recall and names the miss", () => {
  const score = scoreFindings(PLANTED_STREAM, perfect.slice(0, 2));
  assert.equal(score.recovered, 2);
  assert.ok(score.recall > 0.66 && score.recall < 0.67);
  assert.deepEqual(score.missedIds, ["planted-correlation"]);
});

test("an unknown finding kind is dropped rather than scored", () => {
  assert.equal(normalizeReportedFinding({ kind: "vibe", summary: "x", evidence: ["inc-1"] }), undefined);
  assert.equal(normalizeReportedFinding({ kind: "incident", summary: "x", evidence: ["inc-1"] })?.kind, "incident");
  assert.deepEqual(normalizeReportedFinding({ kind: "incident", summary: 1, evidence: [1, "inc-1"] })?.evidence, ["inc-1"]);
});
