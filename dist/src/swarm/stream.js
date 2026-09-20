/**
 * Stage one of the signal swarm: a planted event stream with known ground truth.
 *
 * The code-fixing gym is scored by a held-out test. A finding about an event
 * stream has no equivalent test, so the ground truth is PLANTED in the stream:
 * a known escalating incident, a slow-burn pattern, a cross-source correlation,
 * decoys that look significant and are not, and genuinely ambiguous items that
 * are scored OUTSIDE the gate.
 *
 * Carry over the corpus lesson: ambiguous items stay ambiguous and are never
 * relabelled to agree with whichever model is running. Ground truth here is
 * authored once, before any model runs.
 */
export const FINDING_KINDS = ["incident", "slow-burn", "correlation"];
export const PLANTED_STREAM = {
    name: "planted-ops-stream-v1",
    events: [
        // 1. An incident that escalates across several messages.
        { id: "inc-1", at: 0, source: "status-page", text: "We are investigating elevated error rates on the checkout service." },
        { id: "inc-2", at: 6, source: "monitoring", text: "checkout 5xx rate 2.1% and rising (baseline 0.2%)." },
        { id: "inc-3", at: 14, source: "support", text: "Several customers report checkout payments failing with a 503." },
        { id: "inc-4", at: 22, source: "status-page", text: "Checkout is degraded for all users; we are rolling back the last deploy." },
        { id: "inc-5", at: 31, source: "monitoring", text: "checkout 5xx rate 9.4%; rollback in progress." },
        // 2. A slow-burn pattern, only visible across many events.
        { id: "burn-1", at: 40, source: "monitoring", text: "search p99 latency 210ms (yesterday 180ms)." },
        { id: "burn-2", at: 95, source: "monitoring", text: "search p99 latency 240ms." },
        { id: "burn-3", at: 150, source: "monitoring", text: "search p99 latency 275ms; no alerts fired." },
        { id: "burn-4", at: 205, source: "monitoring", text: "search p99 latency 320ms." },
        { id: "burn-5", at: 260, source: "monitoring", text: "search p99 latency 360ms; index size up 40% week over week." },
        { id: "burn-6", at: 315, source: "support", text: "A few users mention search feels slower than last month." },
        // 3. A correlation between two sources within minutes.
        { id: "rel-1", at: 360, source: "release-notes", text: "Deployed recommendations-service v2.3 at 14:02 UTC." },
        { id: "corr-1", at: 366, source: "monitoring", text: "recommendations error rate jumped to 4% at 14:05 UTC, first time above 1% this month." },
        { id: "corr-2", at: 372, source: "social", text: "Anyone else seeing recommendations break since about an hour ago?" },
        // Decoys: look significant, are expected or benign.
        { id: "dec-1", at: 400, source: "monitoring", text: "Traffic to the marketing landing page is 8x normal during the campaign." },
        { id: "dec-2", at: 430, source: "status-page", text: "Scheduled maintenance for the analytics warehouse begins Saturday 02:00 UTC." },
        // Ambiguous: genuinely both, scored outside the gate.
        { id: "amb-1", at: 460, source: "monitoring", text: "API p99 latency 480ms, above the 400ms target but within the 600ms error budget." },
        { id: "amb-2", at: 500, source: "release-notes", text: "Feature flag checkout_v2 enabled for 5% of users." },
    ],
    planted: [
        { id: "planted-incident", kind: "incident", summary: "checkout 5xx escalation requiring a rollback", evidence: ["inc-1", "inc-2", "inc-3", "inc-4", "inc-5"], match: "any" },
        { id: "planted-slow-burn", kind: "slow-burn", summary: "search p99 latency climbing steadily over hours", evidence: ["burn-1", "burn-2", "burn-3", "burn-4", "burn-5", "burn-6"], match: "any" },
        { id: "planted-correlation", kind: "correlation", summary: "recommendations errors began right after the v2.3 deploy", evidence: ["rel-1", "corr-1"], match: "all" },
    ],
    ambiguous: [
        { id: "amb-latency", note: "above target but within the error budget: a finding, a non-finding, or both", evidence: ["amb-1"] },
        { id: "amb-flag", note: "a flag at 5% could be routine or the start of a problem", evidence: ["amb-2"] },
    ],
    decoys: [
        { id: "decoy-traffic", reason: "campaign traffic is expected load, not an incident", evidence: ["dec-1"] },
        { id: "decoy-maintenance", reason: "planned maintenance is scheduled, not an alert", evidence: ["dec-2"] },
    ],
};
/** The stream as one JSON object per line, the form the tools read. */
export function streamToJsonl(stream = PLANTED_STREAM) {
    return `${stream.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}
export function parseStreamJsonl(text) {
    return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}
/** Every event id referenced by planted, ambiguous or decoy ground truth. */
export function groundTruthEventIds(stream = PLANTED_STREAM) {
    const ids = new Set();
    for (const entry of [...stream.planted, ...stream.ambiguous, ...stream.decoys]) {
        for (const id of entry.evidence)
            ids.add(id);
    }
    return ids;
}
