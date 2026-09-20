import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorActivities } from "../supervisor/activities.js";
import { ScriptedSessionProbe } from "../supervisor/probe.js";

test("activities route to the configured probe and report the probe's delivery", async () => {
  const probe = new ScriptedSessionProbe(["blocked", "idle"]);
  const activities = createSupervisorActivities({ probeFor: () => probe });
  assert.equal((await activities.probeSession({ target: "t:0.0" })).status, "blocked");
  assert.equal((await activities.probeSession({ target: "t:0.0" })).status, "idle");
  const poke = await activities.pokeSession({ target: "t:0.0", text: "hi" });
  assert.equal(poke.delivered, true);
  assert.deepEqual(probe.pokes, ["hi"]);
});

test("escalate sends an escalation message naming the session and blocked time", async () => {
  const probe = new ScriptedSessionProbe(["blocked"]);
  const activities = createSupervisorActivities({ probeFor: () => probe });
  const result = await activities.escalate({ sessionId: "s1", target: "t:0.0", status: "blocked", blockedMs: 5_000, escalations: 1 });
  assert.equal(result.delivered, true);
  assert.match(probe.pokes[0]!, /\[supervisor\] s1 has been blocked for 5s \(escalation 1\)/);
});

test("an undelivered poke is reported, not hidden", async () => {
  const probe = new ScriptedSessionProbe(["blocked"]);
  probe.poke = async () => ({ delivered: false, attempts: 3, evidence: "not seen" });
  const activities = createSupervisorActivities({ probeFor: () => probe });
  const result = await activities.escalate({ sessionId: "s1", target: "t:0.0", status: "blocked", blockedMs: 1_000, escalations: 1 });
  assert.equal(result.delivered, false);
  assert.equal(result.evidence, "not seen");
});
