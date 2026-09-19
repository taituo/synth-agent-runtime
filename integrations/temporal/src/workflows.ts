import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { AgentActivities, DurableAgentState } from "./contracts.js";

export const sendMessage = defineSignal<[DurableAgentState["mailbox"][number]]>("sendMessage");
export const cancelAgent = defineSignal("cancelAgent");
export const getAgentState = defineQuery<DurableAgentState>("getAgentState");

const { runTurn } = proxyActivities<AgentActivities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "1 minute",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
  },
});

/**
 * Durable logical agent loop. The workflow owns lifecycle/mailbox state; the
 * actual Pi/model/tool turn executes as an activity in a normal worker process.
 */
export async function durableAgentWorkflow(initial: DurableAgentState): Promise<DurableAgentState> {
  const state: DurableAgentState = structuredClone(initial);
  let cancelled = false;
  let wake = state.mailbox.length > 0;

  setHandler(sendMessage, (message) => {
    state.mailbox.push(message);
    state.updatedAt = Date.now();
    wake = true;
  });
  setHandler(cancelAgent, () => {
    cancelled = true;
    wake = true;
  });
  setHandler(getAgentState, () => structuredClone(state));

  while (!cancelled && state.status !== "completed" && state.status !== "failed") {
    await condition(() => wake || cancelled);
    if (cancelled) break;
    wake = false;
    if (state.mailbox.length === 0) continue;

    state.status = "running";
    state.updatedAt = Date.now();
    try {
      const result = await runTurn({ agentId: state.agentId, messages: structuredClone(state.mailbox) });
      state.lastResult = result.result;
      state.status = result.state ?? "idle";
      state.updatedAt = Date.now();
      if (state.status === "idle" && state.mailbox.length > 0) {
        // Activities decide which messages they consumed in the external store.
        // A production binding normally stores a durable cursor rather than
        // clearing blindly; this compact example treats one run as one batch.
        state.mailbox.length = 0;
      }
    } catch (error) {
      state.status = "failed";
      state.lastError = error instanceof Error ? error.message : String(error);
      state.updatedAt = Date.now();
    }
  }

  if (cancelled) {
    state.status = "cancelled";
    state.updatedAt = Date.now();
  }
  return state;
}
