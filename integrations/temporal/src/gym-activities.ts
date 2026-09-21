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
import { getPersistentSandboxRunner, hasPersistentSandboxRunner, releasePersistentSandboxRunner } from "../../gym/sandbox.js";
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

function currentAttempt(): number {
  try {
    return ActivityContext.current().info.attempt;
  } catch {
    return 1;
  }
}

/**
 * Effect ids must be unique per turn (and per activity attempt). The broker
 * replays a committed/failed receipt by id; without the turn prefix a tool the
 * model retries in a later turn (same name, same argument index) returned the
 * FIRST turn's cached result, so a corrected `replace_in_file` never ran. Found
 * live: the durable arm scored 0 B on a real model that had fixed the file.
 */
export function turnScopedEffectId(turn: number, attempt: number, id: string): string {
  return `t${turn}:a${attempt}:${id}`;
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

const decoder = new TextDecoder();

/** Decode a rung byte output (Uint8Array or its JSON form) to text. */
function bytesToText(output: unknown): string {
  if (output instanceof Uint8Array) return decoder.decode(output);
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && Array.isArray((output as { data?: unknown }).data)) {
    return decoder.decode(Uint8Array.from((output as { data: number[] }).data));
  }
  return JSON.stringify(output ?? null);
}

/**
 * Render a rung observation the way the plain arm's tools do, so both arms feed
 * the model the same text. Without this the model sees `read_file` as a byte
 * array and cannot read the source.
 */
export function renderGymObservation(name: string, ok: boolean, output: unknown, error?: string): string {
  if (name === "read_file") return bytesToText(output);
  if (name === "list_files") return Array.isArray(output) ? output.join("\n") : bytesToText(output);
  if (name === "run_visible_test") {
    const result = output as { exitCode?: number; stdout?: string; stderr?: string } | undefined;
    const code = result?.exitCode ?? (ok ? 0 : 1);
    return `${code === 0 ? "PASS" : "FAIL"} (exit ${code})\n${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.trim();
  }
  if (ok) return "ok";
  return error ?? "error";
}

function checkpointStore(): { store: BlobGymCheckpointStore; blobs: FileSystemBlobStore } {
  const dir = process.env.SYNTH_GYM_CHECKPOINT_DIR ?? "/tmp/opencode/gym-checkpoints";
  // ONE blob store for both the checkpoint record and the workspace diff.
  const blobs = new FileSystemBlobStore(join(dir, "blobs"));
  return { store: new BlobGymCheckpointStore(blobs, join(dir, "pointers")), blobs };
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
      const { store: checkpoint, blobs } = checkpointStore();
      // The latest checkpoint is the durable reference: its workspace digest (a
      // workspace diff in the blob store) is what a cold worker restores from,
      // and its patch is the legacy fallback for records written before the
      // workspace digest existed.
      const previous = await checkpoint.load(key);
      const sandbox = await getPersistentSandboxRunner({
        repoDir: prepared.repoDir,
        image: attempt.image,
        ...(attempt.namespace ? { namespace: attempt.namespace } : {}),
        ...(attempt.kubectlContext ? { kubectlContext: attempt.kubectlContext } : {}),
        ...(attempt.runtimeClassName ? { runtimeClassName: attempt.runtimeClassName } : {}),
        agentId: attempt.agentId,
        key,
        // A cold cache means a fresh worker process: restore the agent's
        // committed workspace from the durable checkpoint into the cache before
        // the first effect materializes the new Pod.
        ...(cold && previous?.workspaceDigest ? { restore: { blobStore: blobs, digest: previous.workspaceDigest } } : {}),
      });
      // Legacy checkpoints (and local attempts) carry no workspace digest; fall
      // back to replaying the harvested patch into the fresh pod.
      if (cold && previous && !previous.workspaceDigest && previous.patchText.trim().length > 0) {
        const restorePath = ".gym-restore.patch";
        await sandbox.runner.write(restorePath, previous.patchText);
        const applied = await sandbox.runner.exec(`git apply ${restorePath}`, { cwd: prepared.repoDir });
        await sandbox.runner.exec(`rm -f ${restorePath}`, { cwd: prepared.repoDir });
        if (applied.code !== 0) {
          throw new Error(`failed to restore checkpoint: ${applied.stderr || applied.stdout}`);
        }
      }

      const userText = [prepared.userPrompt, ...transcript.map(renderTranscriptEntry)].join("\n\n");
      const baseToEffect = buildToEffect(prepared.tools);
      const attemptNo = currentAttempt();
      const toEffect: NonNullable<Parameters<typeof createGatewayAgentEngine>[0]["toEffect"]> = (call, ctx, index) => {
        const effect = baseToEffect(call, ctx, index);
        return effect ? { ...effect, id: turnScopedEffectId(input.turn, attemptNo, effect.id) } : undefined;
      };
      const engine = createGatewayAgentEngine({
        baseUrl: attempt.gatewayBaseUrl,
        model: attempt.model,
        ...(attempt.apiKey ? { apiKey: attempt.apiKey } : {}),
        ...(attempt.gatewayTimeoutMs !== undefined ? { timeoutMs: attempt.gatewayTimeoutMs } : {}),
        systemPrompt: prepared.systemPrompt,
        buildUserMessage: () => userText,
        parseToolCalls: (content) => parseGymToolCalls(content) as never,
        toEffect,
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
      const rendered = outcome.observations.map((observation) => ({
        name: observation.name,
        ok: observation.ok,
        content: renderGymObservation(observation.name, observation.ok, observation.output, observation.error),
      }));
      const nextTranscript: GymTranscriptMessage[] = [
        ...transcript,
        { role: "assistant", content: outcome.content },
        ...rendered.map((observation) => ({ role: "tool" as const, name: observation.name, content: observation.content })),
      ];
      // After the turn's effects commit, checkpoint the POD WORKSPACE (not only
      // the git patch) into the same blob store, and carry its digest in the
      // durable checkpoint record. A resumed attempt restores from that digest,
      // so committed edits that git alone would not carry survive a SIGKILL. A
      // turn with no workspace effect leaves no live pod; carry the previous
      // digest forward rather than dropping the reference.
      const workspaceDigest = (await sandbox.checkpointWorkspace(blobs)) ?? previous?.workspaceDigest;
      await checkpoint.save(key, {
        turnIndex: input.turn + 1,
        patchText: patch,
        transcript: nextTranscript,
        requestedModel: outcome.requestedModel,
        servedModel: outcome.servedModel,
        ...(workspaceDigest ? { workspaceDigest } : {}),
        ...(previous?.digest ? { parentDigest: previous.digest } : {}),
      });
      return {
        content: outcome.content,
        toolCalls: outcome.toolCalls,
        observations: rendered,
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
    // The persistent pod outlives the turn loop; the attempt is over, so
    // destroy it rather than leak it for the worker's lifetime.
    await releasePersistentSandboxRunner(input.prepared.checkpointKey);
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
