/**
 * Temporal worker for the gym's durable arm.
 *
 *   SYNTH_EXECUTOR_IMAGE=... SYNTH_KUBERNETES_NAMESPACE=... \
 *     integrations/temporal/node_modules/.bin/tsx integrations/temporal/gym-worker.ts
 *
 * Registers `gymAttemptWorkflow` and the gym activities. The durable arm then
 * requires only a client submit (see `integrations/gym/run-gym.ts`).
 */
import { fileURLToPath } from "node:url";
import { runTemporalWorker } from "./src/worker.js";
import { createGymActivities } from "./src/gym-activities.js";

await runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./src/gym-workflows.ts", import.meta.url)),
  // The worker's activity type is broader than the gym contract; the gym
  // activities are additive and registered alongside the agent ones.
  activities: createGymActivities() as never,
});
