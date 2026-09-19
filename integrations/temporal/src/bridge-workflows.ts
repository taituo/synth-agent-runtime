import { proxyActivities } from "@temporalio/workflow";
import type {
  HarnessBridgeActivities,
  HarnessInferenceRequest,
  HarnessInferenceResult,
  HarnessToolRequest,
  HarnessToolResult,
} from "./bridge-contracts.js";

const activities = proxyActivities<HarnessBridgeActivities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
});

/**
 * One durable inference operation. The harness keeps ownership of its agent
 * loop; Temporal owns admission/order/recovery for this physical model call.
 */
export async function harnessInferenceWorkflow(
  input: HarnessInferenceRequest,
): Promise<HarnessInferenceResult> {
  return activities.forwardInference(input);
}

/**
 * One durable tool operation. Automatic Temporal retries are deliberately
 * disabled: a callback may have performed an external side effect before its
 * response is lost. The adapter/tool callback is expected to dedupe by
 * toolCallId; unresolved outcomes stay visible instead of being replayed.
 */
export async function harnessToolWorkflow(
  input: HarnessToolRequest,
): Promise<HarnessToolResult> {
  return activities.forwardToolExecution(input);
}
