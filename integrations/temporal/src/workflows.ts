import {
  condition,
  defineQuery,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { AgentActivities, DurableAgentState } from "./contracts.js";
import { clone, isNonRetryableFailure, nextParkBackoffMs, rootCauseMessage } from "./correlation.js";

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
  // Consecutive transient failures, used to grow the park backoff. Reset on a
  // successful turn.
  let parkAttempt = 0;

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
      const returned = result.state ?? "idle";
      state.updatedAt = Date.now();
      if (returned === "waiting") {
        // The activity deferred this turn without consuming the mailbox. Treat
        // it exactly like a transient park: keep the mailbox intact, back off,
        // then retry. Reusing the park path means a deferring activity can
        // never busy-loop the workflow (a zero-delay re-run with a non-empty
        // mailbox would otherwise spin at ~12 activity calls/second).
        parkAttempt += 1;
        const backoffMs = nextParkBackoffMs(parkAttempt, state.parkBackoff);
        state.status = "waiting";
        state.lastError = undefined;
        log.warn("synth.workflow.parked", { attempt: parkAttempt, backoffMs, reason: "activity-returned-waiting" });
        await condition(() => cancelled, backoffMs);
        if (cancelled) break;
        continue;
      }
      state.status = returned;
      state.lastError = undefined;
      parkAttempt = 0;
      if (returned === "idle") {
        // Remove exactly the messages this turn consumed. Anything appended
        // by a signal that arrived while the activity was running (i.e.
        // beyond consumedCount) must survive to be processed by the next
        // iteration, not be silently discarded.
        state.mailbox.splice(0, consumedCount);
      }
    } catch (error) {
      const cause = rootCauseMessage(error);
      if (isNonRetryableFailure(error)) {
        // Permanent failure (bad credentials, malformed request, ...): no
        // amount of waiting will help, so end immediately.
        state.status = "failed";
        state.lastError = cause;
        state.updatedAt = Date.now();
        break;
      }
      // Transient failure with retries exhausted: PARK, do not die. The
      // mailbox is left intact so the same turn is retried after a backoff.
      // (An unbounded park/retry loop grows workflow history; Continue-As-New
      // is the production remedy and is out of scope here.)
      parkAttempt += 1;
      const backoffMs = nextParkBackoffMs(parkAttempt, state.parkBackoff);
      state.status = "waiting";
      state.lastError = cause;
      state.updatedAt = Date.now();
      log.warn("synth.workflow.parked", { attempt: parkAttempt, backoffMs, error: cause });
      // Wake early only for cancellation: new messages do NOT cut the backoff
      // short, because the provider is presumably still down. Messages that
      // arrive meanwhile stay queued and are picked up after the wait.
      await condition(() => cancelled, backoffMs);
      if (cancelled) break;
    }
  }

  if (cancelled) {
    state.status = "cancelled";
    state.updatedAt = Date.now();
  }
  return state;
}
