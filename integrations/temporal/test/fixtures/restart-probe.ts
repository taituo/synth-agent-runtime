/**
 * Track 6 worker-restart probe: a minimal workflow with a SHORT heartbeat
 * timeout so a killed worker is detected and the activity is retried quickly
 * (the real durableAgentWorkflow uses a 1-minute heartbeat, too slow for a test).
 */
import { proxyActivities } from "@temporalio/workflow";

const { runTurn } = proxyActivities<{ runTurn(): Promise<{ result?: unknown }> }>({
  startToCloseTimeout: "30 seconds",
  heartbeatTimeout: "2 seconds",
  retry: { maximumAttempts: 5, initialInterval: "100 milliseconds" },
});

export async function restartProbeWorkflow(): Promise<string> {
  const result = await runTurn();
  return String(result.result);
}
