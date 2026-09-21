import { fileURLToPath } from "node:url";
import type { WorkerDeploymentOptions } from "@temporalio/worker";
import {
  directProviderSettings,
  providersFromEnv,
  selectProvider,
} from "../../../src/inference/gateway/provider-config.js";
import { createGatewayRunTurn } from "./gateway-run-turn.js";
import { createGymActivities } from "./gym-activities.js";
import { runTemporalWorker } from "./worker.js";

/**
 * The ONE production worker entry point.
 *
 * It registers the runtime's durable agent workflow AND the gym's durable
 * attempt on the configured task queue, so a single deployment (N replicas
 * behind one task queue) runs every path: triage turns, tool-using durable
 * turns, and scored gym attempts. There is no gym-specific worker entry to
 * start; `integrations/gym/run-gym.ts` only submits a client request.
 *
 * The workflows are one bundle (`workflows-all.ts`); the gym's turn activity is
 * `gymRunTurn` so it does not collide with the runtime's `runTurn` activity.
 *
 * The worker is trusted control-plane code: it holds the gateway and Kubernetes
 * credentials and dispatches model-authored code into gVisor Pods. Replicas are
 * stateless; scale by raising `spec.replicas` (see
 * `deploy/kubernetes/worker-deployment.yaml`).
 *
 * Provider configuration (the runtime triage turn needs one; the gym carries its
 * own gateway per attempt):
 *   SYNTH_GATEWAY_PROVIDERS='[{"id":"alpha","baseUrl":"...","model":"...","apiKey":"..."}]'
 *   or SYNTH_PROVIDER_<ID>_BASEURL/_MODEL/_API_KEY, or GATEWAY_BASE_URL/_MODEL.
 *
 * Scaling / operations:
 *   TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE / TEMPORAL_TASK_QUEUE
 *   SYNTH_WORKER_MAX_CONCURRENT_ACTIVITIES   native activity concurrency
 *   SYNTH_WORKER_MAX_CONCURRENT_WORKFLOWS    native workflow-task concurrency
 *   SYNTH_WORKER_HEALTH_PORT                 serve GET /healthz for k8s probes
 *   SYNTH_WORKER_DEPLOYMENT_NAME + SYNTH_WORKER_BUILD_ID   Worker Deployment
 *     versioning (preview); SYNTH_WORKER_DEFAULT_VERSIONING_BEHAVIOR=PINNED
 *     pins runs to their build. Without a deployment name, a bare
 *     SYNTH_WORKER_BUILD_ID enables classic Build-ID versioning.
 *
 *   SYNTH_POSTGRES_URL  consumed by Postgres-backed stores/activities; the
 *                       triage turn itself does not read Postgres.
 */
function resolveProvider(): { baseUrl: string; model: string; apiKey?: string } {
  const providers = providersFromEnv();
  if (providers.length > 0) {
    const requested = process.env.GATEWAY_MODEL;
    const provider = (requested ? selectProvider({ providers }, requested) : undefined) ?? providers[0]!;
    return directProviderSettings(provider);
  }
  const baseUrl = process.env.GATEWAY_BASE_URL;
  const model = process.env.GATEWAY_MODEL;
  if (!baseUrl) throw new Error("GATEWAY_BASE_URL or SYNTH_GATEWAY_PROVIDERS is required");
  if (!model) throw new Error("GATEWAY_MODEL is required");
  return { baseUrl, model, ...(process.env.GATEWAY_API_KEY ? { apiKey: process.env.GATEWAY_API_KEY } : {}) };
}

/** Parse a positive integer env var; undefined when unset or invalid. */
function positiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Worker Deployment versioning, when a name and build id are configured. */
function deploymentOptions(): WorkerDeploymentOptions | undefined {
  const deploymentName = process.env.SYNTH_WORKER_DEPLOYMENT_NAME;
  const buildId = process.env.SYNTH_WORKER_BUILD_ID;
  if (!deploymentName || !buildId) return undefined;
  return {
    version: { deploymentName, buildId },
    useWorkerVersioning: true,
    defaultVersioningBehavior: process.env.SYNTH_WORKER_DEFAULT_VERSIONING_BEHAVIOR === "PINNED" ? "PINNED" : "AUTO_UPGRADE",
  };
}

const buildId = process.env.SYNTH_WORKER_BUILD_ID;
const deployment = deploymentOptions();
const maxActivities = positiveInt("SYNTH_WORKER_MAX_CONCURRENT_ACTIVITIES");
const maxWorkflows = positiveInt("SYNTH_WORKER_MAX_CONCURRENT_WORKFLOWS");
const healthPort = positiveInt("SYNTH_WORKER_HEALTH_PORT");

// One line an operator can read from `kubectl logs` to see the effective shape.
console.log(JSON.stringify({
  worker: "synth-agent-runtime",
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "synth-agent-runtime",
  workflows: ["durableAgentWorkflow", "gymAttemptWorkflow"],
  activities: ["runTurn", "gymPrepareActivity", "gymRunTurn", "gymScoreActivity"],
  maxConcurrentActivityTaskExecutions: maxActivities ?? null,
  maxConcurrentWorkflowTaskExecutions: maxWorkflows ?? null,
  healthPort: healthPort ?? null,
  deployment: deployment ? deployment.version : null,
  buildId: buildId ?? null,
}));

await runTemporalWorker({
  // One bundle: durableAgentWorkflow (runtime) + gymAttemptWorkflow (gym).
  workflowsPath: fileURLToPath(new URL("./workflows-all.js", import.meta.url)),
  // ONE activities object: the runtime `runTurn` and the gym activities coexist
  // because the gym turn is `gymRunTurn`.
  activities: {
    runTurn: createGatewayRunTurn(resolveProvider()),
    ...createGymActivities(),
  },
  ...(process.env.TEMPORAL_ADDRESS ? { address: process.env.TEMPORAL_ADDRESS } : {}),
  ...(process.env.TEMPORAL_NAMESPACE ? { namespace: process.env.TEMPORAL_NAMESPACE } : {}),
  ...(process.env.TEMPORAL_TASK_QUEUE ? { taskQueue: process.env.TEMPORAL_TASK_QUEUE } : {}),
  ...(maxActivities !== undefined ? { maxConcurrentActivityTaskExecutions: maxActivities } : {}),
  ...(maxWorkflows !== undefined ? { maxConcurrentWorkflowTaskExecutions: maxWorkflows } : {}),
  ...(deployment
    ? { workerDeploymentOptions: deployment }
    : buildId
      ? { buildId, useVersioning: true }
      : {}),
  ...(healthPort !== undefined ? { healthPort } : {}),
});
