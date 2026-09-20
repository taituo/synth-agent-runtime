/**
 * The scored-attempt isolation refusal lives at the ACTIVITY boundary, not only
 * in the drivers: a direct `gymAttemptWorkflow` start with `runner:"local"` must
 * be refused before it materializes a task or spends a model call. This test
 * calls the activity directly (no worker, no cluster, no model).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGymActivities } from "../src/gym-activities.js";

function input(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "test-agent",
    taskDir: "/nonexistent/gym-task",
    workDir: "/tmp/opencode/gym-activities-test",
    gatewayBaseUrl: "http://127.0.0.1:9",
    model: "none",
    maxTurns: 1,
    deadlineMs: 1_000,
    image: "unused",
    ...overrides,
  };
}

test("a scored attempt with runner:local is refused as non-retryable, before any filesystem work", async () => {
  const activities = createGymActivities();
  await assert.rejects(
    () => activities.runGymAttemptActivity(input({ runner: "local" }) as never),
    (error: unknown) => {
      const e = error as { message?: string; type?: string; nonRetryable?: boolean };
      assert.equal(e.nonRetryable, true, "the refusal must be non-retryable (no park, no retry)");
      assert.equal(e.type, "GymUnisolatedScoredRun");
      assert.match(e.message ?? "", /unisolated/);
      return true;
    },
  );
});

test("runner:sandbox is not refused by the isolation check (it fails later, on the missing task)", async () => {
  const activities = createGymActivities();
  await assert.rejects(
    () => activities.runGymAttemptActivity(input({ runner: "sandbox" }) as never),
    (error: unknown) => {
      const message = (error as { message?: string }).message ?? "";
      assert.doesNotMatch(message, /unisolated/, "sandbox must pass the isolation gate");
      assert.match(message, /ENOENT|no such file|gym task/i, `expected a task-load failure, got: ${message}`);
      return true;
    },
  );
});

// --- runTurn: the activity the runtime's durableAgentWorkflow proxies ---------

test("runTurn carries the attempt parameters in the mailbox message and refuses local", async () => {
  const activities = createGymActivities();
  const params = input({ runner: "local" });
  await assert.rejects(
    () => activities.runTurn({ agentId: "a", messages: [{ id: "m", role: "human", text: JSON.stringify(params), createdAt: 0 }] }),
    (error: unknown) => {
      const e = error as { nonRetryable?: boolean; type?: string };
      assert.equal(e.nonRetryable, true, "a direct durableAgentWorkflow start must be refused non-retryably");
      assert.equal(e.type, "GymUnisolatedScoredRun");
      return true;
    },
  );
});

test("runTurn rejects a missing or non-JSON attempt message rather than running an attempt", async () => {
  const activities = createGymActivities();
  await assert.rejects(
    () => activities.runTurn({ agentId: "a", messages: [] }),
    /attempt parameters as the first mailbox message/,
  );
  await assert.rejects(
    () => activities.runTurn({ agentId: "a", messages: [{ id: "m", role: "human", text: "not json", createdAt: 0 }] }),
    /parameters are not JSON/,
  );
});
