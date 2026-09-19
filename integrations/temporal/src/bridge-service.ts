import { pathToFileURL } from "node:url";
import { createHttpHarnessBridgeActivities } from "./bridge-activities.js";
import { TemporalHarnessBridgeClient } from "./bridge-client.js";
import { runHarnessBridgeServer } from "./bridge-server.js";
import { createHarnessBridgeWorker } from "./bridge-worker.js";

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function runHarnessBridgeServiceFromEnv(): Promise<void> {
  const temporalAddress = process.env.TEMPORAL_ADDRESS;
  const taskQueue = process.env.SYNTH_TEMPORAL_TASK_QUEUE ?? "synth-agent-runtime";
  const inferenceBaseUrl = process.env.SYNTH_INFERENCE_UPSTREAM_URL;
  if (!inferenceBaseUrl) {
    throw new Error("SYNTH_INFERENCE_UPSTREAM_URL is required");
  }
  const allowedToolCallbackOrigins = csv(process.env.SYNTH_TOOL_CALLBACK_ORIGINS);
  if (allowedToolCallbackOrigins.length === 0) {
    throw new Error("SYNTH_TOOL_CALLBACK_ORIGINS must contain at least one exact origin");
  }

  const activities = createHttpHarnessBridgeActivities({
    inferenceBaseUrl,
    inferenceApiKey: process.env.SYNTH_INFERENCE_UPSTREAM_API_KEY,
    allowedToolCallbackOrigins,
    toolCallbackBearerToken: process.env.SYNTH_TOOL_CALLBACK_TOKEN,
  });
  const worker = await createHarnessBridgeWorker({
    activities,
    address: temporalAddress,
    taskQueue,
    namespace: process.env.TEMPORAL_NAMESPACE,
    identity: process.env.SYNTH_TEMPORAL_WORKER_IDENTITY,
  });
  const client = await TemporalHarnessBridgeClient.connect(temporalAddress);

  await Promise.all([
    worker.run(),
    runHarnessBridgeServer({
      client,
      host: process.env.SYNTH_BRIDGE_HOST ?? "127.0.0.1",
      port: Number.parseInt(process.env.SYNTH_BRIDGE_PORT ?? "8788", 10),
      bearerToken: process.env.SYNTH_BRIDGE_TOKEN,
    }),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHarnessBridgeServiceFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
