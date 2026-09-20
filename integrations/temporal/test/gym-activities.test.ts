/**
 * The scored-attempt isolation refusal lives at the ACTIVITY boundary, not only
 * in the drivers: a direct workflow start with `runner:"local"` must be refused
 * before it materializes a task or spends a model call. These tests call the
 * activities directly (no worker, no cluster, no model).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGymActivities } from "../src/gym-activities.js";
import type { GymPreparedAttempt } from "../src/gym-contracts.js";

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

function prepared(overrides: Record<string, unknown> = {}): GymPreparedAttempt {
  return {
    attempt: input(overrides) as never,
    repoDir: "/nonexistent/repo",
    baseRepoDir: "/nonexistent/repo",
    visibleTestPath: "test/visible.test.mjs",
    systemPrompt: "SYS",
    userPrompt: "USER",
    tools: [],
    checkpointKey: "k",
  };
}

test("gymPrepareActivity refuses a scored run on runner:local as non-retryable, before filesystem work", async () => {
  const activities = createGymActivities();
  await assert.rejects(
    () => activities.gymPrepareActivity(input({ runner: "local" }) as never),
    (error: unknown) => {
      const e = error as { message?: string; type?: string; nonRetryable?: boolean };
      assert.equal(e.nonRetryable, true, "the refusal must be non-retryable (no park, no retry)");
      assert.equal(e.type, "GymUnisolatedScoredRun");
      assert.match(e.message ?? "", /unisolated/);
      return true;
    },
  );
});

test("runTurn refuses a scored turn on runner:local before touching the rung", async () => {
  const activities = createGymActivities();
  await assert.rejects(
    () => activities.runTurn({ prepared: prepared({ runner: "local" }), turn: 0, transcript: [] }),
    (error: unknown) => {
      const e = error as { nonRetryable?: boolean; type?: string };
      assert.equal(e.nonRetryable, true);
      assert.equal(e.type, "GymUnisolatedScoredRun");
      return true;
    },
  );
});

test("gymScoreActivity refuses a scored run on runner:local", async () => {
  const activities = createGymActivities();
  await assert.rejects(
    () =>
      activities.gymScoreActivity({
        prepared: prepared({ runner: "local" }),
        patch: "",
        turns: 0,
        callCount: 0,
        httpAttempts: 0,
        requestedModel: "m",
        servedModel: null,
        modelSubstituted: false,
        wallTimeMs: 0,
      }),
    (error: unknown) => (error as { nonRetryable?: boolean }).nonRetryable === true,
  );
});

test("gymPrepareActivity passes the isolation gate for runner:sandbox (it fails later, on the missing task)", async () => {
  const activities = createGymActivities();
  await assert.rejects(
    () => activities.gymPrepareActivity(input({ runner: "sandbox" }) as never),
    (error: unknown) => {
      const message = (error as { message?: string }).message ?? "";
      assert.doesNotMatch(message, /unisolated/, "sandbox must pass the isolation gate");
      assert.match(message, /ENOENT|no such file|gym task/i, `expected a task-load failure, got: ${message}`);
      return true;
    },
  );
});
