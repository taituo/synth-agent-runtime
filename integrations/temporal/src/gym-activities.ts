/**
 * Durable-arm activity: build the runner (sandbox when `runner=sandbox`, else
 * local), run the SHARED `runGymAttempt`, and return the plain record shape. The
 * workflow around it supplies the park/backoff durability; this file supplies
 * the model call (direct gateway) and the tool surface.
 *
 * NOTE: the recorded fault matrix used `runner=local` for both arms; the sandbox
 * branch here is the isolated option, proven live by `sandbox-live.ts`.
 *
 * This is the ENFORCEMENT point, not just the drivers: a scored attempt may not
 * run on the local host runner, because model-authored code there can read the
 * held-out vectors. A direct `gymAttemptWorkflow` start with `runner:"local"`
 * (bypassing the drivers) is refused here as a non-retryable failure, and the
 * output is labelled `unisolated` either way.
 */
import { join } from "node:path";
import { ApplicationFailure, Context as ActivityContext } from "@temporalio/activity";
import { BlobGymCheckpointStore, DEFAULT_GATEWAY_RETRY, createGatewayGymTurn, describeGymRunner, FileSystemBlobStore, loadGymTask, localEffectRunner, materializeGymTask, runGymAttempt, type EffectRunner } from "../../../src/index.js";
import { buildSandboxRunner } from "../../gym/sandbox.js";
import type { AgentActivities, RunTurnInput, RunTurnResult } from "./contracts.js";
import type { GymAttemptActivities, GymAttemptActivityInput, GymAttemptActivityOutput } from "./gym-contracts.js";

/**
 * The gym's durable activities.
 *
 * `runGymAttemptActivity` runs one whole attempt (plant -> the shared loop ->
 * harvest -> score). `runTurn` is the activity the runtime's
 * `durableAgentWorkflow` proxies: it carries the attempt parameters in the
 * mailbox message and runs the same attempt, so the gym's durable arm is
 * `gymAttemptWorkflow` (orchestrator) -> `durableAgentWorkflow` (agent) ->
 * `runTurn` (this) -> the shared turn body `GatewayAgentEngine` -> the sandbox
 * rung's `process.exec`.
 */
export function createGymActivities(): GymAttemptActivities & Pick<AgentActivities, "runTurn"> {
  const runGymAttemptActivity = async (input: GymAttemptActivityInput): Promise<GymAttemptActivityOutput> => {
      const heartbeat = setInterval(() => {
        try {
          ActivityContext.current().heartbeat();
        } catch {
          // not inside an activity (unit use): nothing to heartbeat
        }
      }, 15_000);
      try {
        // Refuse BEFORE materializing or spending a model call: a direct
        // workflow start must not be able to run a scored attempt unisolated.
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
        const useSandbox = binding.kind === "sandbox";
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
            ...(input.retryMaxAttempts && input.retryMaxAttempts > 1
              ? { retry: { ...DEFAULT_GATEWAY_RETRY, maxAttempts: input.retryMaxAttempts } }
              : {}),
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
            // run_visible_test must invoke the Pod's own node, not the host path
            // the Pod cannot see (which is a 127 "not found").
            ...(useSandbox ? { visibleTestNodeBin: "node" } : {}),
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
            isolation: binding.isolation,
            outcome: record.outcome,
            requestedModel: record.requestedModel,
            servedModel: record.servedModel,
            modelSubstituted: record.modelSubstituted,
            wallTimeMs: record.wallTimeMs,
            callCount: record.callCount,
            turns: record.turns,
            httpAttempts: record.httpAttempts,
            protectedPathsTouched: record.protectedPathsTouched,
            patchBytes: record.patch.length,
            ...(record.resumedFromTurn !== undefined ? { resumedFromTurn: record.resumedFromTurn } : {}),
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
  };

  return {
    runGymAttemptActivity,
    async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
      // The attempt parameters travel in the mailbox message; the durable
      // workflow owns the mailbox, the activity is pure compute.
      const text = input.messages[0]?.text;
      if (typeof text !== "string" || text.length === 0) {
        throw ApplicationFailure.nonRetryable(
          "the gym runTurn activity requires the attempt parameters as the first mailbox message",
          "GymMissingAttemptParams",
        );
      }
      let params: GymAttemptActivityInput;
      try {
        params = JSON.parse(text) as GymAttemptActivityInput;
      } catch {
        throw ApplicationFailure.nonRetryable("the gym runTurn parameters are not JSON", "GymBadAttemptParams");
      }
      const output = await runGymAttemptActivity(params);
      return { result: output, state: "completed" };
    },
  };
}
