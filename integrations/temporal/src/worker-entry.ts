import { fileURLToPath } from "node:url";
import { createGatewayRunTurn } from "./gateway-run-turn.js";
import { runTemporalWorker } from "./worker.js";

/**
 * Production entry point for the Temporal worker — the runtime.
 *
 * The worker owns the durable workflow and runs the `runTurn` activity (the
 * shared `GatewayAgentEngine`). Model-authored code does NOT run here: the
 * engine dispatches `process.exec` through the execution rung to a Kubernetes /
 * gVisor executor Pod.
 *
 * Environment:
 *   TEMPORAL_ADDRESS    Temporal frontend, e.g. temporal-frontend:7233
 *   TEMPORAL_NAMESPACE  default: "default"
 *   TEMPORAL_TASK_QUEUE default: "synth-agent-runtime"
 *   GATEWAY_BASE_URL    OpenAI-compatible gateway base URL (required)
 *   GATEWAY_MODEL       model id the turn requests (required)
 *   GATEWAY_API_KEY     optional bearer token for the gateway
 *   SYNTH_POSTGRES_URL  consumed by Postgres-backed stores/activities; the
 *                       triage turn itself does not read Postgres.
 */
const gatewayBaseUrl = process.env.GATEWAY_BASE_URL;
const model = process.env.GATEWAY_MODEL;
if (!gatewayBaseUrl) throw new Error("GATEWAY_BASE_URL is required");
if (!model) throw new Error("GATEWAY_MODEL is required");

await runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
  activities: {
    runTurn: createGatewayRunTurn({
      baseUrl: gatewayBaseUrl,
      model,
      ...(process.env.GATEWAY_API_KEY ? { apiKey: process.env.GATEWAY_API_KEY } : {}),
    }),
  },
  ...(process.env.TEMPORAL_ADDRESS ? { address: process.env.TEMPORAL_ADDRESS } : {}),
  ...(process.env.TEMPORAL_NAMESPACE ? { namespace: process.env.TEMPORAL_NAMESPACE } : {}),
  ...(process.env.TEMPORAL_TASK_QUEUE ? { taskQueue: process.env.TEMPORAL_TASK_QUEUE } : {}),
});
