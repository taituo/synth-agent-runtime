/**
 * Durable-arm activity: run the SHARED `runSwarmAttempt` against the real
 * gateway, with a blob-backed checkpoint so a retried activity resumes from the
 * findings already reported. The workflow around it supplies park/backoff.
 *
 * Both arms use the local runner here: the event stream is not a git repo, and
 * holding the runner constant is what makes the arms a durability comparison.
 */
import { join } from "node:path";
import { Context as ActivityContext } from "@temporalio/activity";
import {
  BlobSwarmCheckpointStore,
  FileSystemBlobStore,
  createGatewaySwarmTurn,
  localEffectRunner,
  runSwarmAttempt,
} from "../../../src/index.js";
import type { SwarmAttemptActivities, SwarmAttemptActivityInput, SwarmAttemptActivityOutput } from "./swarm-contracts.js";

export function createSwarmActivities(): SwarmAttemptActivities {
  return {
    async runSwarmAttemptActivity(input: SwarmAttemptActivityInput): Promise<SwarmAttemptActivityOutput> {
      const heartbeat = setInterval(() => {
        try {
          ActivityContext.current().heartbeat();
        } catch {
          // not inside an activity (unit use): nothing to heartbeat
        }
      }, 15_000);
      try {
        const startedAt = Date.now();
        const runner = localEffectRunner(input.workDir);
        const turn = createGatewaySwarmTurn({
          baseUrl: input.gatewayBaseUrl,
          model: input.model,
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
          ...(input.gatewayTimeoutMs ? { timeoutMs: input.gatewayTimeoutMs } : {}),
        });
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
        const checkpointDir = process.env.SYNTH_SWARM_CHECKPOINT_DIR ?? "/tmp/opencode/swarm-checkpoints";
        const checkpoint = new BlobSwarmCheckpointStore(
          new FileSystemBlobStore(join(checkpointDir, "blobs")),
          join(checkpointDir, "pointers"),
        );
        let resumedFromTurn: number | undefined;
        if (input.checkpointKey) {
          const restored = await checkpoint.load(input.checkpointKey);
          if (restored) resumedFromTurn = restored.turnIndex;
        }
        const record = await runSwarmAttempt({
          runner,
          turn: tracedTurn,
          maxTurns: input.maxTurns,
          deadlineMs: input.deadlineMs,
          checkpoint,
          ...(input.checkpointKey ? { checkpointKey: input.checkpointKey } : {}),
          onTool: ({ call, observation }) => {
            trace.push(`tool ${call.name}: ${observation.slice(0, 300)}`);
          },
        });
        // A transient turn failure throws out of runSwarmAttempt, so Temporal's
        // activity retry and the workflow's park/backoff engage naturally.
        return {
          arm: "durable",
          recovered: record.score.recovered,
          planted: record.score.plantedCount,
          recall: record.score.recall,
          precision: record.score.precision,
          spurious: record.score.spurious,
          decoyReports: record.score.decoyReports,
          ambiguousReports: record.score.ambiguousReports,
          turns: record.turns,
          finished: record.finished,
          toolCalls: record.transcript.filter((entry) => entry.role === "tool").length,
          requestedModel: record.requestedModel ?? null,
          servedModel: record.servedModel ?? null,
          modelSubstituted: record.modelSubstituted,
          wallTimeMs: Date.now() - startedAt,
          ...(resumedFromTurn !== undefined ? { resumedFromTurn } : {}),
          trace: trace.slice(0, 60),
        };
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
