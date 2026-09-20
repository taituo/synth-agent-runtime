/**
 * Durable arm: `swarmAttemptWorkflow`.
 *
 * Same park/backoff body as `gymAttemptWorkflow`. The activity runs the shared
 * `runSwarmAttempt`, so the durable and plain arms are the same loop with
 * durability as the only difference: durability either preserves the findings
 * made before a SIGKILL or it does not.
 */
import { log, proxyActivities, sleep } from "@temporalio/workflow";
import type { SwarmAttemptActivities, SwarmAttemptActivityInput, SwarmAttemptActivityOutput } from "./swarm-contracts.js";
import {
  clampParkHintMs,
  isNonRetryableFailure,
  nextParkBackoffMs,
  retryAfterMsFromError,
  rootCauseMessage,
} from "./correlation.js";

const { runSwarmAttemptActivity } = proxyActivities<SwarmAttemptActivities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
  },
});

function errored(input: SwarmAttemptActivityInput, message: string): SwarmAttemptActivityOutput {
  return {
    arm: "durable",
    recovered: 0,
    planted: 0,
    recall: 0,
    precision: 1,
    spurious: 0,
    decoyReports: 0,
    ambiguousReports: 0,
    turns: 0,
    finished: false,
    toolCalls: 0,
    requestedModel: input.model,
    servedModel: null,
    modelSubstituted: false,
    wallTimeMs: 0,
    error: message,
  };
}

export async function swarmAttemptWorkflow(input: SwarmAttemptActivityInput): Promise<SwarmAttemptActivityOutput> {
  let parkAttempt = 0;
  while (true) {
    try {
      return await runSwarmAttemptActivity(input);
    } catch (error) {
      const cause = rootCauseMessage(error);
      if (isNonRetryableFailure(error)) return errored(input, cause);
      const rawHint = retryAfterMsFromError(error);
      const hint = clampParkHintMs(rawHint);
      const backoffMs = hint ?? nextParkBackoffMs(++parkAttempt);
      log.warn("synth.swarm.parked", { attempt: parkAttempt, backoffMs, reason: hint !== undefined ? "server-retry-hint" : "backoff", error: cause });
      await sleep(backoffMs);
    }
  }
}
