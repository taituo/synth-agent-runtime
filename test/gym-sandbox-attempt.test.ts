/**
 * A real attempt through the sandbox: the agent's tool calls execute in the
 * gVisor pod (including `run_visible_test` via the pod's own node), the patch is
 * harvested from the pod and scored on the host against the held-out vectors.
 *
 * Zero model calls: the turn is scripted. The point is the physical path, not
 * the model. The golden fix must score `passed`; a turn that changes nothing must
 * score `failed` (the planted bug is still present).
 *
 * Live cluster required. Set SYNTH_LIVE_GVISOR=1 to run; it SKIPs otherwise, and
 * a skip is never a pass. It uses the repo's pinned executor image by default
 * (override with SYNTH_EXECUTOR_IMAGE for a different cluster import).
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXECUTOR_IMAGE,
  GymFixtureUnavailableError,
  loadGymTask,
  materializeGymTask,
  runGymAttempt,
  type GymTurn,
} from "../src/index.js";
import { buildSandboxRunner } from "../integrations/gym/sandbox.js";

const HE_TASK = "test/fixtures/gym-tasks/he/hex-decode";
const BUGGED = "parseInt(hexDigits, 10)";
const FIXED = "parseInt(hexDigits, 16)";

function liveEnabled(): boolean {
  return process.env.SYNTH_LIVE_GVISOR === "1";
}

test("a sandbox attempt runs the tools in the pod and scores the golden fix passed", async (t: TestContext) => {
  if (!liveEnabled()) {
    t.skip("set SYNTH_LIVE_GVISOR=1 to run the live sandbox attempt");
    return;
  }
  const work = await mkdtemp(join(tmpdir(), "gym-sbx-attempt-"));
  let sandbox: Awaited<ReturnType<typeof buildSandboxRunner>> | undefined;
  try {
    let materialized;
    try {
      const task = await loadGymTask(HE_TASK);
      materialized = await materializeGymTask({
        task,
        workDir: work,
        ...(process.env.SYNTH_FIXTURE_REPOS ? { fixtureCacheDir: process.env.SYNTH_FIXTURE_REPOS } : {}),
      });
    } catch (error) {
      if (error instanceof GymFixtureUnavailableError) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    sandbox = await buildSandboxRunner({
      repoDir: materialized.repoDir,
      image: process.env.SYNTH_EXECUTOR_IMAGE ?? EXECUTOR_IMAGE,
      ...(process.env.SYNTH_KUBERNETES_NAMESPACE ? { namespace: process.env.SYNTH_KUBERNETES_NAMESPACE } : {}),
      ...(process.env.SYNTH_RUNTIME_CLASS ? { runtimeClassName: process.env.SYNTH_RUNTIME_CLASS } : {}),
      agentId: "gym-sandbox-attempt",
    });

    // Control first: a no-op attempt leaves the bug in place and must fail.
    // Order matters — the two attempts share one workspace, so the mutating
    // golden attempt must run last.
    const noop = await runGymAttempt({
      task: materialized,
      runner: sandbox.runner,
      turn: async () => ({ toolCalls: [{ name: "finish" }], requestedModel: "scripted", servedModel: "scripted" }),
      visibleTestNodeBin: "node",
      maxTurns: 1,
      deadlineMs: 120_000,
    });
    assert.equal(noop.outcome, "failed", "an unchanged checkout must fail");

    const goldenTurn: GymTurn = async () => ({
      toolCalls: [
        { name: "replace_in_file", arguments: { path: "he.js", old_text: BUGGED, new_text: FIXED } },
        { name: "run_visible_test" },
        { name: "finish" },
      ],
      requestedModel: "scripted",
      servedModel: "scripted",
    });

    const golden = await runGymAttempt({
      task: materialized,
      runner: sandbox.runner,
      turn: goldenTurn,
      visibleTestNodeBin: "node",
      maxTurns: 2,
      deadlineMs: 300_000,
    });
    assert.equal(golden.outcome, "passed", `golden sandbox fix must pass; detail=${golden.score.detail ?? ""}`);
  } finally {
    await sandbox?.close();
    await rm(work, { recursive: true, force: true });
  }
});
