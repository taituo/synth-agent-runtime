/**
 * The gym's durable activities, one turn per activity.
 *
 *   gymPrepareActivity  materialize the bugged task on the host; build the gym
 *                       system/user prompts and the serializable tool surface.
 *   runTurn             ONE model turn through the runtime's one body,
 *                       `GatewayAgentEngine`, with the gym's `turnConfig`
 *                       (`buildToEffect`) and the sandbox rung's `executeEffect`.
 *                       Harvest the agent's patch and checkpoint it.
 *   gymScoreActivity    apply the final patch to a fresh clone of the bugged
 *                       commit and score it against the held-out vectors.
 *
 * The workflow owns the loop and the transcript; the workspace survives between
 * activities through the persistent rung (see `sandbox.ts`), restored from the
 * attempt checkpoint if the worker restarted.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationFailure, Context as ActivityContext } from "@temporalio/activity";
import {
  BlobGymCheckpointStore,
  buildGymSystemPrompt,
  buildGymUserPrompt,
  createGatewayAgentEngine,
  describeGymRunner,
  FileSystemBlobStore,
  harvestPatch,
  isolatedScoreGymPatch,
  loadGymTask,
  materializeGymTask,
  parseGymToolCalls,
  type AgentEngineContext,
  type GatewayTurnOutcome,
  type GymScore,
} from "../../../src/index.js";
import { getPersistentSandboxRunner, hasPersistentSandboxRunner } from "../../gym/sandbox.js";
import { buildToEffect } from "./gateway-run-turn.js";
import type { DurableToolSpec } from "./contracts.js";
import type {
  GymActivities,
  GymAttemptActivityInput,
  GymAttemptActivityOutput,
  GymPreparedAttempt,
  GymScoreActivityInput,
  GymTranscriptMessage,
  GymTurnActivityInput,
  GymTurnActivityResult,
} from "./gym-contracts.js";

function heartbeatFor(): () => void {
  return () => {
    try {
      ActivityContext.current().heartbeat();
    } catch {
      // not inside an activity (unit use): nothing to heartbeat
    }
  };
}

/** The gym tool surface, mapped to execution-rung effects for the engine. */
function gymToolSpecs(visibleTestPath: string): DurableToolSpec[] {
  return [
    { name: "list_files", effect: "workspace.list", pathArg: "path" },
    { name: "read_file", effect: "workspace.read", pathArg: "path" },
    { name: "write_file", effect: "workspace.write", pathArg: "path", contentArg: "content" },
    { name: "replace_in_file", effect: "workspace.replace", pathArg: "path", oldTextArg: "old_text", newTextArg: "new_text" },
    // The tool name implies the command; the model passes no argument.
    { name: "run_visible_test", effect: "process.exec", command: `node --test ${visibleTestPath}` },
    // `finish` has no rung mapping: the engine records it as refused and the
    // workflow reads it off the turn's tool calls to stop the loop.
  ];
}

function renderTranscriptEntry(entry: GymTranscriptMessage): string {
  return entry.role === "assistant" ? entry.content : `Observation from ${entry.name ?? "tool"}:\n${entry.content}`;
}

function checkpointStore(): BlobGymCheckpointStore {
  const dir = process.env.SYNTH_GYM_CHECKPOINT_DIR ?? "/tmp/opencode/gym-checkpoints";
  return new BlobGymCheckpointStore(new FileSystemBlobStore(join(dir, "blobs")), join(dir, "pointers"));
}

export function createGymActivities(): GymActivities {
  const gymPrepareActivity = async (input: GymAttemptActivityInput): Promise<GymPreparedAttempt> => {
    const heartbeat = setInterval(heartbeatFor(), 15_000);
    try {
      const binding = describeGymRunner(input.runner ?? "sandbox");
      if (!binding.scoredAllowed) {
        throw ApplicationFailure.nonRetryable(
          `refusing to score a run on the "${binding.kind}" runner: it is unisolated and model-authored code ` +
            `can read the held-out vectors on the host. Start the workflow with runner:"sandbox" (gVisor).`,
          "GymUnisolatedScoredRun",
        );
      }
      const task = await loadGymTask(input.taskDir);
      const materialized = await materializeGymTask({
        task,
        workDir: input.workDir,
        ...(input.fixtureCacheDir ? { fixtureCacheDir: input.fixtureCacheDir } : {}),
      });
      let visibleTestContent = "";
      try {
        visibleTestContent = await readFile(materialized.visibleTestPath, "utf8");
      } catch {
        // A missing visible test is not fatal; the scorer still decides.
      }
      return {
        attempt: input,
        repoDir: materialized.repoDir,
        baseRepoDir: materialized.baseRepoDir,
        visibleTestPath: task.visibleTestPath,
        systemPrompt: buildGymSystemPrompt(task.visibleTestPath),
        userPrompt: buildGymUserPrompt({ visibleTestPath: task.visibleTestPath, visibleTestContent }),
        tools: gymToolSpecs(task.visibleTestPath),
        checkpointKey: input.checkpointKey ?? `${input.agentId}-${materialized.bugCommit}`,
      };
    } finally {
      clearInterval(heartbeat);
    }
  };

  const runTurn = async (input: GymTurnActivityInput): Promise<GymTurnActivityResult> => {
    const heartbeat = setInterval(heartbeatFor(), 15_000);
    try {
      const { prepared, transcript } = input;
      const attempt = prepared.attempt;
      const binding = describeGymRunner(attempt.runner ?? "sandbox");
      if (!binding.scoredAllowed) {
        throw ApplicationFailure.nonRetryable(
          `refusing to score a run on the "${binding.kind}" runner: it is unisolated and model-authored code ` +
            `can read the held-out vectors on the host. Start the workflow with runner:"sandbox" (gVisor).`,
          "GymUnisolatedScoredRun",
        );
      }
      const key = prepared.checkpointKey;
      const cold = !hasPersistentSandboxRunner(key);
      const sandbox = await getPersistentSandboxRunner({
        repoDir: prepared.repoDir,
        image: attempt.image,
        ...(attempt.namespace ? { namespace: attempt.namespace } : {}),
        ...(attempt.kubectlContext ? { kubectlContext: attempt.kubectlContext } : {}),
        ...(attempt.runtimeClassName ? { runtimeClassName: attempt.runtimeClassName } : {}),
        agentId: attempt.agentId,
        key,
      });
      const checkpoint = checkpointStore();
      // A cold cache means a fresh worker process: restore the agent's work
      // product (the checkpointed patch) before the turn, so the transcript and
      // the workspace agree.
      if (cold) {
        const saved = await checkpoint.load(key);
        if (saved && saved.patchText.trim().length > 0) {
          const restorePath = ".gym-restore.patch";
          await sandbox.runner.write(restorePath, saved.patchText);
          const applied = await sandbox.runner.exec(`git apply ${restorePath}`, { cwd: prepared.repoDir });
          await sandbox.runner.exec(`rm -f ${restorePath}`, { cwd: prepared.repoDir });
          if (applied.code !== 0) {
            throw new Error(`failed to restore checkpoint: ${applied.stderr || applied.stdout}`);
          }
        }
      }

      const userText = [prepared.userPrompt, ...transcript.map(renderTranscriptEntry)].join("\n\n");
      const engine = createGatewayAgentEngine({
        baseUrl: attempt.gatewayBaseUrl,
        model: attempt.model,
        ...(attempt.apiKey ? { apiKey: attempt.apiKey } : {}),
        ...(attempt.gatewayTimeoutMs !== undefined ? { timeoutMs: attempt.gatewayTimeoutMs } : {}),
        systemPrompt: prepared.systemPrompt,
        buildUserMessage: () => userText,
        parseToolCalls: (content) => parseGymToolCalls(content) as never,
        toEffect: buildToEffect(prepared.tools),
      });
      const context: AgentEngineContext = {
        agentId: attempt.agentId as never,
        workspaceId: `gym:${attempt.agentId}` as never,
        definition: { id: attempt.agentId, inferenceProfile: { id: attempt.model, model: attempt.model } },
        inferenceProfile: { id: attempt.model, model: attempt.model },
        signal: new AbortController().signal,
        emitOutput: () => {},
        emitTool: () => {},
        // The tools execute through the rung (the sandbox broker), not the loop.
        executeEffect: (effect, minFidelity) => sandbox.executeEffect(effect, minFidelity),
      };
      const outcome = (await engine.run([], context)) as GatewayTurnOutcome;
      const finished = outcome.toolCalls.some((call) => call.name === "finish");
      const patch = await harvestPatch(sandbox.runner, { repoDir: prepared.repoDir });
      const nextTranscript: GymTranscriptMessage[] = [
        ...transcript,
        { role: "assistant", content: outcome.content },
        ...outcome.observations.map((observation) => ({
          role: "tool" as const,
          name: observation.name,
          content: JSON.stringify(observation.output ?? observation.error ?? null),
        })),
      ];
      await checkpoint.save(key, {
        turnIndex: input.turn + 1,
        patchText: patch,
        transcript: nextTranscript,
        requestedModel: outcome.requestedModel,
        servedModel: outcome.servedModel,
      });
      return {
        content: outcome.content,
        toolCalls: outcome.toolCalls,
        observations: outcome.observations,
        finished,
        patch,
        requestedModel: outcome.requestedModel ?? attempt.model,
        servedModel: outcome.servedModel ?? null,
        modelSubstituted: outcome.modelSubstituted ?? false,
        latencyMs: outcome.latencyMs ?? 0,
        httpAttempts: 1,
      };
    } finally {
      clearInterval(heartbeat);
    }
  };

  const gymScoreActivity = async (input: GymScoreActivityInput): Promise<GymAttemptActivityOutput> => {
    const binding = describeGymRunner(input.prepared.attempt.runner ?? "sandbox");
    if (!binding.scoredAllowed) {
      throw ApplicationFailure.nonRetryable(
        `refusing to score a run on the "${binding.kind}" runner: it is unisolated.`,
        "GymUnisolatedScoredRun",
      );
    }
    const task = await loadGymTask(input.prepared.attempt.taskDir);
    const cases = task.hiddenCases ?? [];
    let score: GymScore;
    if (input.error !== undefined) {
      score = { outcome: "errored", touchedPaths: [], detail: input.error };
    } else if (input.patch.trim().length === 0) {
      score = { outcome: "failed", touchedPaths: [], detail: "no changes; the planted bug is still present" };
    } else {
      score = await isolatedScoreGymPatch({ patchText: input.patch, baseRepoDir: input.prepared.baseRepoDir, cases });
    }
    return {
      arm: "durable",
      isolation: binding.isolation,
      outcome: score.outcome,
      requestedModel: input.requestedModel,
      servedModel: input.servedModel,
      modelSubstituted: input.modelSubstituted,
      wallTimeMs: input.wallTimeMs,
      callCount: input.callCount,
      turns: input.turns,
      httpAttempts: input.httpAttempts,
      protectedPathsTouched: score.touchedPaths,
      patchBytes: input.patch.length,
      ...(score.detail ? { detail: score.detail } : {}),
    };
  };

  return { gymPrepareActivity, runTurn, gymScoreActivity };
}
