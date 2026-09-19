/**
 * Small concurrent swarm for the durable agent workflow.
 *
 * Runs three separate `durableAgentWorkflow` instances at the same time, each
 * fed its own ordered typed-event stream from `SWARM_SCRIPTS`. Asserts two
 * things: each instance processed exactly its own event sequence, and no trace
 * event or worker log ever pairs one instance's agentId with another's
 * workflowId (correlation must never cross-contaminate).
 *
 * Requires a Temporal dev server (verified against
 * `temporal server start-dev --port 7243`, namespace `default`):
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx swarm-driver.ts
 */
import { pathToFileURL } from "node:url";
import { SWARM_SCRIPTS, logCorrelationViolations, swarmIsolationViolations } from "./event-script.js";
import { runScript, startEventRunner } from "./event-runner.js";

export async function main(): Promise<void> {
  const runner = await startEventRunner();
  const stamp = Date.now();
  const agents = SWARM_SCRIPTS.map((entry) => ({ agentId: `agt_swarm_${entry.name}_${stamp}`, script: entry.script }));

  const runs = await Promise.all(agents.map((agent) => runScript(runner, agent.agentId, agent.script)));

  const expected = Object.fromEntries(agents.map((agent) => [agent.agentId, agent.script.map((event) => event.kind)]));
  const sequenceOk = runs.every(
    (run) => JSON.stringify(run.processed) === JSON.stringify(expected[run.agentId]),
  );
  const traceViolations = swarmIsolationViolations(runner.trace, agents.map((agent) => agent.agentId));
  const logViolations = logCorrelationViolations(runner.logs, agents.map((agent) => agent.agentId));
  const isolationOk = traceViolations.length === 0 && logViolations.length === 0;

  console.log(
    JSON.stringify(
      {
        traceFile: runner.traceFile,
        expected,
        runs,
        sequenceOk,
        isolationOk,
        traceViolations,
        logViolations,
        ok: sequenceOk && isolationOk,
      },
      null,
      2,
    ),
  );
  await runner.close();
  process.exit(sequenceOk && isolationOk ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
