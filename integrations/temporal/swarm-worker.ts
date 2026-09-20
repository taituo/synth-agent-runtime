/**
 * Temporal worker for the swarm's durable arm.
 *
 *   SYNTH_SWARM_TASK_QUEUE=swarm-fault \
 *     integrations/temporal/node_modules/.bin/tsx integrations/temporal/swarm-worker.ts
 *
 * Registers `swarmAttemptWorkflow` and the swarm activities. A dedicated task
 * queue per fault run lets a harness kill exactly one worker.
 */
import { fileURLToPath } from "node:url";
import { runTemporalWorker } from "./src/worker.js";
import { createSwarmActivities } from "./src/swarm-activities.js";

await runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./src/swarm-workflows.ts", import.meta.url)),
  activities: createSwarmActivities() as never,
  taskQueue: process.env.SYNTH_SWARM_TASK_QUEUE ?? "synth-swarm",
  ...(process.env.TEMPORAL_ADDRESS ? { address: process.env.TEMPORAL_ADDRESS } : {}),
});
