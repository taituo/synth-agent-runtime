/**
 * Durable gym attempt: `gymAttemptWorkflow` is the ORCHESTRATOR, not a turn.
 *
 * It hands the attempt parameters to the runtime's `durableAgentWorkflow` as the
 * agent (one mailbox message), which runs the shared turn body
 * `GatewayAgentEngine` through its `runTurn` activity, and maps the agent's final
 * state back to the gym's attempt output. The `runTurn` activity is the gym's
 * attempt activity: it plants the task, runs the shared `runGymAttempt` loop
 * (whose only model boundary is the runtime's engine), harvests the patch and
 * scores it. So the durable arm's path is
 *
 *   gymAttemptWorkflow -> durableAgentWorkflow -> runTurn ->
 *   GatewayAgentEngine -> sandbox rung `process.exec` (gVisor pod)
 *
 * and there is exactly one gateway turn body.
 */
import { executeChild, log } from "@temporalio/workflow";
import { durableAgentWorkflow } from "./workflows.js";
import type { DurableAgentState } from "./contracts.js";

// The worker bundles this module as the workflow entrypoint, and the generated
// entrypoint registers only the module's exports. Re-export the runtime agent
// workflow (and its signals/query) so `executeChild(durableAgentWorkflow, ...)`
// resolves to a registered workflow type on the gym worker.
export { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./workflows.js";
import type { GymAttemptActivityInput, GymAttemptActivityOutput } from "./gym-contracts.js";

function isolationOf(input: GymAttemptActivityInput): "unisolated" | "gvisor" {
  return (input.runner ?? "sandbox") === "sandbox" ? "gvisor" : "unisolated";
}

function errored(input: GymAttemptActivityInput, message: string): GymAttemptActivityOutput {
  return {
    arm: "durable",
    isolation: isolationOf(input),
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
  const runner = input.runner ?? "sandbox";
  const agentId = input.agentId || "gym-attempt";
  const state: DurableAgentState = {
    agentId,
    status: "idle",
    // The attempt parameters travel as the agent's first (and only) message; the
    // runTurn activity parses them. The workflow isolate cannot read the task
    // file, so the gym prompt/tools are built in the activity from the task.
    mailbox: [
      {
        id: `gym-task-${Date.now().toString(36)}`,
        role: "human",
        text: JSON.stringify(input),
        createdAt: Date.now(),
      },
    ],
    updatedAt: Date.now(),
    // The rung selection is carried for observability; the activity builds the
    // live sandbox runner from the attempt parameters.
    turnConfig: {
      rung:
        runner === "sandbox"
          ? {
              kind: "sandbox",
              ...(input.image ? { image: input.image } : {}),
              ...(input.namespace ? { namespace: input.namespace } : {}),
              ...(input.kubectlContext ? { kubectlContext: input.kubectlContext } : {}),
            }
          : { kind: "none" },
    },
  };
  log.info("synth.gym.agent.start", { agentId, runner });
  const final = await executeChild(durableAgentWorkflow, { args: [state] });
  if (final.status === "completed" && final.lastResult !== undefined) {
    return final.lastResult as GymAttemptActivityOutput;
  }
  return errored(input, final.lastError ?? `the durable agent ended ${final.status}`);
}
