import { fileURLToPath } from "node:url";
import {
  directProviderSettings,
  providersFromEnv,
  selectProvider,
} from "../../../src/inference/gateway/provider-config.js";
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
 * The model provider is configuration, not code. Either declare one or more
 * OpenAI-compatible providers (any of them, opencode-go included):
 *   SYNTH_GATEWAY_PROVIDERS='[{"id":"alpha","baseUrl":"...","model":"...","apiKey":"..."}]'
 * or the per-provider env form SYNTH_PROVIDER_<ID>_BASEURL/_MODEL/_API_KEY;
 * `GATEWAY_MODEL` selects which provider/profile this worker binds (default: the
 * first declared). Otherwise fall back to a single endpoint:
 *   GATEWAY_BASE_URL / GATEWAY_MODEL / GATEWAY_API_KEY
 *
 * Other environment:
 *   TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE / TEMPORAL_TASK_QUEUE
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

await runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
  activities: {
    runTurn: createGatewayRunTurn(resolveProvider()),
  },
  ...(process.env.TEMPORAL_ADDRESS ? { address: process.env.TEMPORAL_ADDRESS } : {}),
  ...(process.env.TEMPORAL_NAMESPACE ? { namespace: process.env.TEMPORAL_NAMESPACE } : {}),
  ...(process.env.TEMPORAL_TASK_QUEUE ? { taskQueue: process.env.TEMPORAL_TASK_QUEUE } : {}),
});
