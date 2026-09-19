/**
 * Track 6 replay probe, version 2. Same workflow name as v1 but schedules an
 * extra `runTurn` command, so replaying a v1 history against this bundle is a
 * non-deterministic change and must fail. Used only as the negative control.
 */
import { proxyActivities } from "@temporalio/workflow";

const { runTurn } = proxyActivities<{ runTurn(input: { agentId: string }): Promise<{ result?: unknown }> }>({
  startToCloseTimeout: "1 minute",
});

export async function replayProbeWorkflow(): Promise<string> {
  const result = await runTurn({ agentId: "agt_replay" });
  await runTurn({ agentId: "agt_replay" });
  return String(result.result);
}
