/**
 * Track 6 replay probe, version 1. Records a history with exactly one
 * `runTurn` command. `replay-probe-v2.ts` is the same workflow with an extra
 * command; replaying a v1 history against v2 MUST raise a non-determinism
 * error, which is how the suite proves it would catch a non-deterministic
 * workflow change.
 */
import { proxyActivities } from "@temporalio/workflow";

const { runTurn } = proxyActivities<{ runTurn(input: { agentId: string }): Promise<{ result?: unknown }> }>({
  startToCloseTimeout: "1 minute",
});

export async function replayProbeWorkflow(): Promise<string> {
  const result = await runTurn({ agentId: "agt_replay" });
  return String(result.result);
}
