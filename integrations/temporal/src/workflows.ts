import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { AgentActivities, DurableAgentState } from "./contracts.js";
import { clone, rootCauseMessage } from "./correlation.js";

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
  const state: DurableAgentState = clone(initial);
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
  setHandler(getAgentState, () => clone(state));

  while (!cancelled && state.status !== "completed" && state.status !== "failed") {
    // Also wake on leftover mailbox content (not just a fresh signal): a
    // message that arrived mid-turn and survived the splice below must be
    // processed on the next iteration without waiting for another signal.
    await condition(() => wake || cancelled || state.mailbox.length > 0);
    if (cancelled) break;
    wake = false;
    if (state.mailbox.length === 0) continue;

    state.status = "running";
    state.updatedAt = Date.now();
    // Snapshot exactly which messages this turn is being given. New signals
    // can still append to state.mailbox while the activity below is in
    // flight; only the messages present at snapshot time were "consumed" by
    // this turn.
    const consumedCount = state.mailbox.length;
    try {
      const result = await runTurn({ agentId: state.agentId, messages: clone(state.mailbox) });
      state.lastResult = result.result;
      state.status = result.state ?? "idle";
      state.updatedAt = Date.now();
      if (state.status === "idle") {
        // Remove exactly the messages this turn consumed. Anything appended
        // by a signal that arrived while the activity was running (i.e.
        // beyond consumedCount) must survive to be processed by the next
        // iteration, not be silently discarded.
        state.mailbox.splice(0, consumedCount);
      }
    } catch (error) {
      state.status = "failed";
      state.lastError = rootCauseMessage(error);
      state.updatedAt = Date.now();
    }
  }

  if (cancelled) {
    state.status = "cancelled";
    state.updatedAt = Date.now();
  }
  return state;
}
