/**
 * Durable gym attempt: the workflow OWNS THE LOOP.
 *
 * One `runTurn` activity per turn; the transcript lives in workflow state and
 * continues across activities. Each turn runs the runtime's one body,
 * `GatewayAgentEngine`, with the gym's `turnConfig` and the sandbox rung, so
 * tools (including `run_visible_test`) execute through the rung. The workflow
 * parks (honouring a server retry hint) on a transient turn failure, then scores
 * the final patch against the held-out vectors.
 *
 *   gymAttemptWorkflow -> runTurn (x turns) -> GatewayAgentEngine ->
 *   sandbox rung `process.exec` (gVisor pod)
 */
import { log, proxyActivities, sleep } from "@temporalio/workflow";
import type {
  GymActivities,
  GymAttemptActivityInput,
  GymAttemptActivityOutput,
  GymPreparedAttempt,
  GymTranscriptMessage,
  GymTurnActivityResult,
} from "./gym-contracts.js";
import {
  clampParkHintMs,
  isNonRetryableFailure,
  nextParkBackoffMs,
  retryAfterMsFromError,
  rootCauseMessage,
} from "./correlation.js";

const { gymPrepareActivity, runTurn, gymScoreActivity } = proxyActivities<GymActivities>({
  startToCloseTimeout: "30 minutes",
  // The activity heartbeats every 15s; a 1-minute timeout bounds worker-death
  // detection while a slow reasoning turn is still allowed to finish.
  heartbeatTimeout: "1 minute",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
  },
});

/**
 * One turn, with the durable park path: a transient failure (after Temporal's
 * activity retries) parks with backoff instead of killing the attempt, and a
 * server retry hint is honoured.
 */
async function runTurnWithPark(
  prepared: GymPreparedAttempt,
  turn: number,
  transcript: GymTranscriptMessage[],
): Promise<GymTurnActivityResult> {
  let parkAttempt = 0;
  while (true) {
    try {
      return await runTurn({ prepared, turn, transcript });
    } catch (error) {
      const cause = rootCauseMessage(error);
      if (isNonRetryableFailure(error)) throw error;
      const hint = clampParkHintMs(retryAfterMsFromError(error));
      const backoffMs = hint ?? nextParkBackoffMs(++parkAttempt);
      log.warn("synth.gym.parked", {
        turn,
        attempt: parkAttempt,
        backoffMs,
        reason: hint !== undefined ? "server-retry-hint" : "backoff",
        error: cause,
      });
      await sleep(backoffMs);
    }
  }
}

export async function gymAttemptWorkflow(input: GymAttemptActivityInput): Promise<GymAttemptActivityOutput> {
  const prepared = await gymPrepareActivity(input);
  const transcript: GymTranscriptMessage[] = [];
  const startedAt = Date.now();
  let last: GymTurnActivityResult | undefined;
  let turns = 0;
  let callCount = 0;
  let httpAttempts = 0;
  let errored: string | undefined;

  for (let turn = 0; turn < input.maxTurns; turn++) {
    if (Date.now() - startedAt > input.deadlineMs) break;
    try {
      last = await runTurnWithPark(prepared, turn, transcript);
    } catch (error) {
      errored = rootCauseMessage(error);
      break;
    }
    turns++;
    callCount++;
    httpAttempts += last.httpAttempts;
    if (last.finished) break;
    transcript.push({ role: "assistant", content: last.content });
    for (const observation of last.observations) {
      transcript.push({ role: "tool", name: observation.name, content: observation.content });
    }
  }

  return gymScoreActivity({
    prepared,
    patch: last?.patch ?? "",
    turns,
    callCount,
    httpAttempts,
    requestedModel: last?.requestedModel ?? input.model,
    servedModel: last?.servedModel ?? null,
    modelSubstituted: last?.modelSubstituted ?? false,
    wallTimeMs: Date.now() - startedAt,
    ...(errored !== undefined ? { error: errored } : {}),
  });
}
