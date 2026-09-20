/**
 * Durable-arm activity: build the sandbox runner, run the SHARED
 * `runGymAttempt`, and return the plain record shape. The workflow around it
 * supplies the park/backoff durability; this file supplies the model call
 * (direct gateway) and the sandbox tool surface.
 */
import { Context as ActivityContext } from "@temporalio/activity";
import { createGatewayGymTurn, loadGymTask, materializeGymTask, runGymAttempt } from "../../../src/index.js";
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
        const sandbox = await buildSandboxRunner({
          repoDir: materialized.repoDir,
          image: input.image,
          ...(input.namespace ? { namespace: input.namespace } : {}),
          ...(input.kubectlContext ? { kubectlContext: input.kubectlContext } : {}),
          ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
          agentId: input.agentId,
        });
        try {
          const turn = createGatewayGymTurn({
            baseUrl: input.gatewayBaseUrl,
            model: input.model,
            ...(input.apiKey ? { apiKey: input.apiKey } : {}),
          });
          const record = await runGymAttempt({
            task: materialized,
            runner: sandbox.runner,
            turn,
            maxTurns: input.maxTurns,
            deadlineMs: input.deadlineMs,
          });
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
            ...(record.score.detail ? { detail: record.score.detail } : {}),
            ...(record.error ? { error: record.error } : {}),
          };
        } finally {
          await sandbox.close();
        }
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
