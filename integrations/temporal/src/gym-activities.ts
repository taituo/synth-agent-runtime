/**
 * Durable-arm activity: build the sandbox runner, run the SHARED
 * `runGymAttempt`, and return the plain record shape. The workflow around it
 * supplies the park/backoff durability; this file supplies the model call
 * (direct gateway) and the sandbox tool surface.
 */
import { ApplicationFailure, Context as ActivityContext } from "@temporalio/activity";
import { createGatewayGymTurn, loadGymTask, localEffectRunner, materializeGymTask, runGymAttempt, type EffectRunner } from "../../../src/index.js";
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
          const record = await runGymAttempt({
            task: materialized,
            runner,
            turn,
            maxTurns: input.maxTurns,
            deadlineMs: input.deadlineMs,
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
