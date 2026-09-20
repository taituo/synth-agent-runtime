/**
 * Durable-arm activity: build the sandbox runner, run the SHARED
 * `runGymAttempt`, and return the plain record shape. The workflow around it
 * supplies the park/backoff durability; this file supplies the model call
 * (direct gateway) and the sandbox tool surface.
 */
import { join } from "node:path";
import { ApplicationFailure, Context as ActivityContext } from "@temporalio/activity";
import { BlobGymCheckpointStore, createGatewayGymTurn, FileSystemBlobStore, loadGymTask, localEffectRunner, materializeGymTask, runGymAttempt, type EffectRunner } from "../../../src/index.js";
import { buildSandboxRunner } from "../../gym/sandbox.js";
import type { GymAttemptActivities, GymAttemptActivityInput, GymAttemptActivityOutput } from "./gym-contracts.js";

export function createGymActivities(): GymAttemptActivities {
  return {
    async runGymAttemptActivity(input: GymAttemptActivityInput): Promise<GymAttemptActivityOutput> {
      const heartbeat = setInterval(() => {
        try {
          ActivityContext.current().heartbeat();
        } catch {
          // not inside an activity (unit use): nothing to heartbeat
        }
      }, 15_000);
      try {
        const task = await loadGymTask(input.taskDir);
        const materialized = await materializeGymTask({
          task,
          workDir: input.workDir,
          ...(input.fixtureCacheDir ? { fixtureCacheDir: input.fixtureCacheDir } : {}),
        });
        const useSandbox = (input.runner ?? "sandbox") === "sandbox";
        const sandbox = useSandbox
          ? await buildSandboxRunner({
              repoDir: materialized.repoDir,
              image: input.image,
              ...(input.namespace ? { namespace: input.namespace } : {}),
              ...(input.kubectlContext ? { kubectlContext: input.kubectlContext } : {}),
              ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
              agentId: input.agentId,
            })
          : undefined;
        try {
          const runner: EffectRunner = sandbox ? sandbox.runner : localEffectRunner(materialized.repoDir);
          const turn = createGatewayGymTurn({
            baseUrl: input.gatewayBaseUrl,
            model: input.model,
            ...(input.apiKey ? { apiKey: input.apiKey } : {}),
            ...(input.gatewayTimeoutMs ? { timeoutMs: input.gatewayTimeoutMs } : {}),
          });
          // Capture the trace so a worker-death run can be diagnosed: the first
          // read_file shows which workspace state the (re)started activity saw.
          const trace: string[] = [];
          try {
            trace.push(`activity attempt=${ActivityContext.current().info.attempt} startedAt=${new Date().toISOString()}`);
          } catch {
            trace.push("activity attempt=unknown");
          }
          const tracedTurn: typeof turn = async (turnInput) => {
            const result = await turn(turnInput);
            trace.push(`assistant: ${(result.content ?? JSON.stringify(result.toolCalls)).slice(0, 500)}`);
            return result;
          };
          const checkpointDir = process.env.SYNTH_GYM_CHECKPOINT_DIR ?? "/tmp/opencode/gym-checkpoints";
          const checkpoint = new BlobGymCheckpointStore(
            new FileSystemBlobStore(join(checkpointDir, "blobs")),
            join(checkpointDir, "pointers"),
          );
          const record = await runGymAttempt({
            task: materialized,
            runner,
            turn: tracedTurn,
            maxTurns: input.maxTurns,
            deadlineMs: input.deadlineMs,
            checkpoint,
            ...(input.checkpointKey ? { checkpointKey: input.checkpointKey } : {}),
            onTool: ({ call, observation }) => {
              if (call.name === "read_file") {
                const bugged = observation.includes("parseInt(hexDigits, 10)");
                const fixed = observation.includes("parseInt(hexDigits, 16)");
                trace.push(`tool read_file(${String(call.arguments?.path ?? "")}): workspace=${bugged ? "BUGGED" : fixed ? "FIXED" : "unknown"}`);
              } else {
                trace.push(`tool ${call.name}: ${observation.slice(0, 300)}`);
              }
            },
          });
          // A transient turn failure must THROW so Temporal's activity retry and
          // the workflow's park/backoff engage. Returning an `errored` record
          // would make the durable arm behave exactly like the plain one.
          if (record.failure?.transient && (record.outcome === "errored" || record.outcome === "timed-out")) {
            throw ApplicationFailure.create({
              message: record.failure.message,
              type: "GymTransient",
              details: record.failure.retryAfterMs !== undefined ? [{ retryAfterMs: record.failure.retryAfterMs }] : [],
            });
          }
          return {
            arm: "durable",
            outcome: record.outcome,
            requestedModel: record.requestedModel,
            servedModel: record.servedModel,
            modelSubstituted: record.modelSubstituted,
            wallTimeMs: record.wallTimeMs,
            callCount: record.callCount,
            turns: record.turns,
            protectedPathsTouched: record.protectedPathsTouched,
            patchBytes: record.patch.length,
            trace: trace.slice(0, 60),
            ...(record.score.detail ? { detail: record.score.detail } : {}),
            ...(record.error ? { error: record.error } : {}),
          };
        } finally {
          await sandbox?.close();
        }
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
