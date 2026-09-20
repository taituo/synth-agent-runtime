import test from "node:test";
import assert from "node:assert/strict";
import type { ActivityContext } from "@temporalio/activity";
import {
  agentIdFromArgs,
  agentIdFromWorkflowId,
  compactCorrelation,
  clampParkHintMs,
  isNonRetryableFailure,
  messageKindFromArgs,
  nextParkBackoffMs,
  retryAfterMsFromError,
  rootCauseMessage,
  rungFromArgs,
} from "../src/correlation.js";
import { createSynthActivityInterceptors, type SynthTraceEvent } from "../src/activity-interceptors.js";
import { interceptors as workflowInterceptors } from "../src/workflow-interceptors.js";

function activityContext(overrides: Record<string, unknown> = {}): ActivityContext {
  return {
    info: {
      activityId: "1",
      activityType: "runTurn",
      attempt: 1,
      taskQueue: "synth-agent-runtime",
      workflowType: "durableAgentWorkflow",
      workflowExecution: { workflowId: "agent/agt_123", runId: "run-1" },
      ...overrides,
    },
  } as unknown as ActivityContext;
}

test("correlation helpers derive Synth ids from workflow ids and inputs", () => {
  assert.equal(agentIdFromWorkflowId("agent/agt_123"), "agt_123");
  assert.equal(agentIdFromWorkflowId("agt_456"), "agt_456");
  assert.equal(agentIdFromWorkflowId(undefined), undefined);
  assert.equal(agentIdFromArgs([{ agentId: "agt_789" }]), "agt_789");
  assert.equal(agentIdFromArgs([{ messages: [] }]), undefined);
  assert.equal(agentIdFromArgs([]), undefined);
  assert.deepEqual(compactCorrelation({ agentId: "a", attempt: undefined }), { agentId: "a" });
});

test("messageKindFromArgs reads the kind of the last message, and tolerates legacy input", () => {
  const typed = [{ messages: [{ id: "1", kind: "social_post" }, { id: "2", kind: "incident" }] }];
  assert.equal(messageKindFromArgs(typed), "incident");
  // A bare `sendMessage` signal payload (no wrapping `messages` array).
  assert.equal(messageKindFromArgs([{ id: "1", text: "hi", kind: "news" }]), "news");

  // Untyped/legacy messages must not invent a kind (backward compatibility).
  assert.equal(messageKindFromArgs([{ messages: [{ id: "1" }] }]), undefined);
  assert.equal(messageKindFromArgs([{ messages: [] }]), undefined);
  assert.equal(messageKindFromArgs([{}]), undefined);
  assert.equal(messageKindFromArgs([]), undefined);
  assert.equal(messageKindFromArgs(undefined), undefined);
  // A non-string or empty kind is ignored rather than leaked into telemetry.
  assert.equal(messageKindFromArgs([{ messages: [{ kind: 7 }] }]), undefined);
  assert.equal(messageKindFromArgs([{ messages: [{ kind: "" }] }]), undefined);
});

test("isNonRetryableFailure walks the cause chain for the nonRetryable marker", () => {
  assert.equal(isNonRetryableFailure(new Error("transient")), false);
  assert.equal(isNonRetryableFailure({ nonRetryable: true }), true);
  assert.equal(isNonRetryableFailure({ nonRetryable: false }), false);
  // Temporal wraps an activity failure: the marker sits on a nested cause.
  const permanent = Object.assign(new Error("invalid credentials"), { nonRetryable: true });
  const wrapped = new Error("Activity task failed", { cause: permanent });
  assert.equal(isNonRetryableFailure(wrapped), true);
  assert.equal(isNonRetryableFailure(new Error("outer", { cause: new Error("inner") })), false);
  // A self-referential cause chain must not loop forever.
  const cyclic: { cause?: unknown; nonRetryable?: boolean } = {};
  cyclic.cause = cyclic;
  assert.equal(isNonRetryableFailure(cyclic), false);
});

test("retryAfterMsFromError reads a plain property, a nested cause, or details", () => {
  assert.equal(retryAfterMsFromError(new Error("plain")), undefined);
  assert.equal(retryAfterMsFromError(Object.assign(new Error("hinted"), { retryAfterMs: 2_000 })), 2_000);
  const nested = new Error("Activity task failed", { cause: Object.assign(new Error("429"), { retryAfterMs: 4_000 }) });
  assert.equal(retryAfterMsFromError(nested), 4_000);
  // ApplicationFailure carries it in `details` across the activity boundary.
  assert.equal(retryAfterMsFromError({ message: "429", details: [{ retryAfterMs: 5_000 }] }), 5_000);
  // Non-finite values are ignored.
  assert.equal(retryAfterMsFromError({ retryAfterMs: Number.NaN }), undefined);
  assert.equal(retryAfterMsFromError({ retryAfterMs: Number.POSITIVE_INFINITY }), undefined);
});

test("clampParkHintMs accepts only finite, positive, at-most-one-hour hints", () => {
  assert.equal(clampParkHintMs(2_000), 2_000);
  assert.equal(clampParkHintMs(1), 1);
  assert.equal(clampParkHintMs(60 * 60 * 1000), 60 * 60 * 1000);
  assert.equal(clampParkHintMs(undefined), undefined);
  assert.equal(clampParkHintMs(0), undefined);
  assert.equal(clampParkHintMs(-5), undefined);
  assert.equal(clampParkHintMs(Number.NaN), undefined);
  assert.equal(clampParkHintMs(Number.POSITIVE_INFINITY), undefined);
  assert.equal(clampParkHintMs(60 * 60 * 1000 + 1), undefined, "absurd waits are rejected");
});

test("nextParkBackoffMs grows exponentially, caps, and honours overrides", () => {
  assert.equal(nextParkBackoffMs(1), 5_000);
  assert.equal(nextParkBackoffMs(2), 10_000);
  assert.equal(nextParkBackoffMs(3), 20_000);
  assert.equal(nextParkBackoffMs(20), 300_000, "capped at 5 minutes");
  assert.equal(nextParkBackoffMs(1, { initialMs: 400, maxMs: 1600 }), 400);
  assert.equal(nextParkBackoffMs(2, { initialMs: 400, maxMs: 1600 }), 800);
  assert.equal(nextParkBackoffMs(3, { initialMs: 400, maxMs: 1600 }), 1600);
  assert.equal(nextParkBackoffMs(9, { initialMs: 400, maxMs: 1600 }), 1600, "override cap");
  // A malformed override must never yield a zero/negative wait.
  assert.equal(nextParkBackoffMs(1, { initialMs: 0, maxMs: -1 }), 5_000);
  assert.equal(nextParkBackoffMs(0), 5_000);
});

test("rootCauseMessage surfaces the innermost nested cause", () => {
  const inner = new Error("synthetic activity failure");
  const wrapped = new Error("Activity task failed", { cause: inner });
  assert.equal(rootCauseMessage(wrapped), "synthetic activity failure");
  assert.equal(rootCauseMessage("plain"), "plain");
});

test("activity interceptor attaches correlation to logs and emits a trace span", async () => {
  const events: SynthTraceEvent[] = [];
  const factory = createSynthActivityInterceptors({ trace: { emit: (event) => { events.push(event); } }, maxAttempts: 3 });
  const interceptor = factory(activityContext());

  const result = await interceptor.inbound!.execute!(
    { args: [{ agentId: "agt_123", messages: [] }], headers: {} },
    async () => "turn-result",
  );
  assert.equal(result, "turn-result");

  const attrs = interceptor.outbound!.getLogAttributes!({ base: "x" }, (input) => input);
  assert.deepEqual(attrs, {
    base: "x",
    agentId: "agt_123",
    workflowId: "agent/agt_123",
    workflowType: "durableAgentWorkflow",
    runId: "run-1",
    taskQueue: "synth-agent-runtime",
    activityId: "1",
    activityType: "runTurn",
    attempt: 1,
  });

  assert.deepEqual(events.map((event) => event.phase), ["start", "end"]);
  assert.equal(events[0]!.name, "temporal.activity.runTurn");
  assert.equal(events[0]!.traceId, "agent/agt_123");
  assert.equal(events[0]!.attributes?.agentId, "agt_123");
  assert.equal(events[1]!.attributes?.durationMs !== undefined, true);

  const tags = interceptor.outbound!.getMetricTags!({}, (input) => input);
  assert.equal(tags.agentId, "agt_123");
  assert.equal(tags.activityType, "runTurn");
  assert.equal(tags.attempt, 1);
});

test("rungFromArgs reads the rung kind and surfaces it on correlated logs", async () => {
  assert.equal(rungFromArgs([{ config: { rung: { kind: "sandbox" } } }]), "sandbox");
  assert.equal(rungFromArgs([{ config: { rung: "synthetic" } }]), "synthetic");
  assert.equal(rungFromArgs([{ config: {} }]), undefined);
  assert.equal(rungFromArgs([{ agentId: "a" }]), undefined);
  assert.equal(rungFromArgs(undefined), undefined);

  const events: SynthTraceEvent[] = [];
  const factory = createSynthActivityInterceptors({ trace: { emit: (event) => { events.push(event); } } });
  const interceptor = factory(activityContext());
  await interceptor.inbound!.execute!(
    { args: [{ agentId: "agt_rung", config: { rung: { kind: "sandbox" } } }], headers: {} },
    async () => "ok",
  );
  const attrs = interceptor.outbound!.getLogAttributes!({}, (input) => input);
  assert.equal(attrs.rung, "sandbox", "logs carry the rung");
  assert.equal(events[0]!.attributes?.rung, "sandbox", "trace spans carry the rung");
});

test("activity interceptor surfaces the typed-signal kind on logs and trace spans", async () => {
  const events: SynthTraceEvent[] = [];
  const factory = createSynthActivityInterceptors({ trace: { emit: (event) => { events.push(event); } } });

  const typed = factory(activityContext());
  await typed.inbound!.execute!(
    { args: [{ agentId: "agt_typed", messages: [{ id: "m1", kind: "incident" }] }], headers: {} },
    async () => "ok",
  );
  const attrs = typed.outbound!.getLogAttributes!({}, (input) => input);
  assert.equal(attrs.messageKind, "incident");
  assert.equal(events[0]!.attributes?.messageKind, "incident");
  assert.equal(events[1]!.attributes?.messageKind, "incident");

  // An untyped signal must not gain a messageKind attribute (backward compat).
  const untyped = factory(activityContext());
  await untyped.inbound!.execute!(
    { args: [{ agentId: "agt_untyped", messages: [{ id: "m2" }] }], headers: {} },
    async () => "ok",
  );
  const untypedAttrs = untyped.outbound!.getLogAttributes!({}, (input) => input);
  assert.equal(untypedAttrs.messageKind, undefined);
  assert.equal("messageKind" in untypedAttrs, false);
});

test("activity interceptor reports the retry reason and willRetry on a failed attempt", async () => {
  const events: SynthTraceEvent[] = [];
  const factory = createSynthActivityInterceptors({ trace: { emit: (event) => { events.push(event); } }, maxAttempts: 3 });

  // Attempt 1 fails.
  const first = factory(activityContext());
  await assert.rejects(
    first.inbound!.execute!(
      { args: [{ agentId: "agt_123", messages: [] }], headers: {} },
      async () => { throw new Error("synthetic activity failure"); },
    ),
    /synthetic activity failure/,
  );
  assert.deepEqual(events.map((event) => event.phase), ["start", "error"]);
  assert.equal(events[1]!.attributes?.error, "synthetic activity failure");
  assert.equal(events[1]!.attributes?.willRetry, true);

  // Attempt 2 is a retry: it must know why it is being retried.
  const second = factory(activityContext({ attempt: 2 }));
  const retryAttrs = second.outbound!.getLogAttributes!({}, (input) => input);
  assert.equal(retryAttrs.attempt, 2);
  assert.equal(retryAttrs.retryReason, "synthetic activity failure");

  // A successful retry clears the recorded failure.
  const third = factory(activityContext({ attempt: 3 }));
  const thirdAttrs = third.outbound!.getLogAttributes!({}, (input) => input);
  assert.equal(thirdAttrs.retryReason, "synthetic activity failure");
  await third.inbound!.execute!({ args: [{ agentId: "agt_123" }], headers: {} }, async () => "ok");
  const fourth = factory(activityContext({ attempt: 4 }));
  assert.equal(fourth.outbound!.getLogAttributes!({}, (input) => input).retryReason, undefined);
});

test("a final (non-retryable) failure does not leak its entry in the retry-reason map", async () => {
  // Regression: the original implementation only cleared a recorded failure
  // on success. An activity that fails on every attempt up to maxAttempts
  // (never succeeds) left its entry in the module-level map forever, a slow
  // memory leak in a long-lived worker process. It must be cleared as soon
  // as we know there is no future retry to report it to (willRetry === false).
  const uniqueActivityId = `leak-check-${Date.now()}`;
  const factory = createSynthActivityInterceptors({ maxAttempts: 2 });

  const last = factory(activityContext({ activityId: uniqueActivityId, attempt: 2 }));
  await assert.rejects(
    last.inbound!.execute!(
      { args: [{ agentId: "agt_leak" }], headers: {} },
      async () => { throw new Error("final failure"); },
    ),
    /final failure/,
  );

  // A later attempt for the SAME activity (attempt > 1, so the interceptor
  // actually consults the map) must see no leftover retryReason: the failed
  // final attempt's entry must be gone, not merely overwritten.
  const laterAttempt = factory(activityContext({ activityId: uniqueActivityId, attempt: 5 }));
  const attrs = laterAttempt.outbound!.getLogAttributes!({}, (input) => input);
  assert.equal(attrs.retryReason, undefined);
});

test("workflow interceptor module exports a factory with inbound and outbound hooks", () => {
  const interceptors = workflowInterceptors();
  assert.equal(interceptors.inbound?.length, 1);
  assert.equal(interceptors.outbound?.length, 1);
  assert.equal(typeof interceptors.inbound![0]!.execute, "function");
  assert.equal(typeof interceptors.inbound![0]!.handleSignal, "function");
  assert.equal(typeof interceptors.outbound![0]!.getLogAttributes, "function");
  assert.equal(typeof interceptors.outbound![0]!.scheduleActivity, "function");
});
