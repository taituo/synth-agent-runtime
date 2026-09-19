import test from "node:test";
import assert from "node:assert/strict";
import type { DurableAgentState } from "../src/contracts.js";
import {
  EVENT_SCRIPT,
  isDeterministicReplay,
  projectFinalState,
  sequenceFromTrace,
  type TraceLikeEvent,
} from "../event-script.js";

test("EVENT_SCRIPT is a small ordered schedule with realistic spacing", () => {
  assert.ok(EVENT_SCRIPT.length >= 3 && EVENT_SCRIPT.length <= 5, "3-5 events");
  assert.equal(EVENT_SCRIPT[0]!.delayMs, 0, "first event fires immediately");
  for (const event of EVENT_SCRIPT) {
    assert.equal(typeof event.kind, "string");
    assert.ok(event.kind.length > 0);
    assert.ok(event.text.length > 0);
    assert.ok(event.delayMs >= 0);
  }
  assert.ok(EVENT_SCRIPT.slice(1).every((event) => event.delayMs >= 100), "events are spaced, not a burst");
});

test("projectFinalState drops volatile ids/timestamps and keeps typed mailbox content", () => {
  const state: DurableAgentState = {
    agentId: "agt_1",
    status: "idle",
    mailbox: [
      { id: "m1", role: "human", text: "hello", createdAt: 111 },
      { id: "m2", role: "system", text: "incident", createdAt: 222, kind: "incident" },
    ],
    lastResult: "echo:incident",
    updatedAt: 999,
  };
  const projected = projectFinalState(state);
  assert.deepEqual(projected, {
    status: "idle",
    mailbox: [
      { role: "human", text: "hello", kind: null },
      { role: "system", text: "incident", kind: "incident" },
    ],
    lastResult: "echo:incident",
    lastError: null,
  });
  assert.equal(JSON.stringify(projected).includes("updatedAt"), false);
  assert.equal(JSON.stringify(projected).includes('"id"'), false);
});

test("sequenceFromTrace returns the processed kinds in order, per agent", () => {
  const event = (agentId: string, messageKind?: string): TraceLikeEvent => ({
    name: "temporal.activity.runTurn",
    phase: "start",
    attributes: messageKind === undefined ? { agentId } : { agentId, messageKind },
  });
  const events: TraceLikeEvent[] = [
    event("agt_a", "news"),
    event("agt_b", "incident"),
    { name: "temporal.activity.runTurn", phase: "end", attributes: { agentId: "agt_a", messageKind: "news" } },
    event("agt_a", "social_post"),
    { name: "other.activity", phase: "start", attributes: { agentId: "agt_a", messageKind: "ignored" } },
    event("agt_a"),
    event("agt_a", "news"),
  ];
  assert.deepEqual(sequenceFromTrace(events, "agt_a"), ["news", "social_post", "untyped", "news"]);
  assert.deepEqual(sequenceFromTrace(events, "agt_b"), ["incident"]);
  assert.deepEqual(sequenceFromTrace(events, "agt_missing"), []);
});

test("isDeterministicReplay compares final state and processed sequence", () => {
  const final = projectFinalState({
    agentId: "agt_1",
    status: "idle",
    mailbox: [],
    lastResult: "echo:news",
    updatedAt: 1,
  });
  const a = { final, processed: ["news", "incident"] };
  assert.equal(isDeterministicReplay(a, { final, processed: ["news", "incident"] }), true);
  assert.equal(isDeterministicReplay(a, { final, processed: ["incident", "news"] }), false);
  assert.equal(
    isDeterministicReplay(a, { final: { ...final, lastResult: "echo:other" }, processed: ["news", "incident"] }),
    false,
  );
});
