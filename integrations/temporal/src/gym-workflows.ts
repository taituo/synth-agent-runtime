/**
 * Durable arm: `gymAttemptWorkflow`.
 *
 * Same body as `durableAgentWorkflow`'s transient-failure handling — retry the
 * activity, and when the activity's own retries are exhausted, PARK with
 * exponential backoff (honouring a server `Retry-After` hint) instead of dying.
 * The activity runs the shared `runGymAttempt`, so the durable and plain arms
 * are the same loop with durability as the only difference.
 */
import { log, proxyActivities, sleep } from "@temporalio/workflow";
import type { GymAttemptActivities, GymAttemptActivityInput, GymAttemptActivityOutput } from "./gym-contracts.js";
import {
  clampParkHintMs,
  isNonRetryableFailure,
  nextParkBackoffMs,
  retryAfterMsFromError,
  rootCauseMessage,
} from "./correlation.js";

const { runGymAttemptActivity } = proxyActivities<GymAttemptActivities>({
  startToCloseTimeout: "60 minutes",
  // The activity heartbeats every 15s; a 30s heartbeat timeout keeps
  // worker-death detection bounded for the fault matrix.
  heartbeatTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
  },
});

function errored(input: GymAttemptActivityInput, message: string): GymAttemptActivityOutput {
  return {
    arm: "durable",
    outcome: "errored",
    requestedModel: input.model,
    servedModel: null,
    modelSubstituted: false,
    wallTimeMs: 0,
    callCount: 0,
    turns: 0,
    protectedPathsTouched: [],
    error: message,
  };
}

export async function gymAttemptWorkflow(input: GymAttemptActivityInput): Promise<GymAttemptActivityOutput> {
  let parkAttempt = 0;
  while (true) {
    try {
      return await runGymAttemptActivity(input);
    } catch (error) {
      const cause = rootCauseMessage(error);
      if (isNonRetryableFailure(error)) {
        // Permanent failure (bad credentials, malformed request): no wait helps.
        return errored(input, cause);
      }
      const rawHint = retryAfterMsFromError(error);
      const hint = clampParkHintMs(rawHint);
      const backoffMs = hint ?? nextParkBackoffMs(++parkAttempt);
      log.warn("synth.gym.parked", { attempt: parkAttempt, backoffMs, reason: hint !== undefined ? "server-retry-hint" : "backoff", error: cause });
      await sleep(backoffMs);
    }
  }
}
