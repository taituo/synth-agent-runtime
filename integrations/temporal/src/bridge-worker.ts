import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createSynthActivityInterceptors, type SynthActivityInterceptorOptions } from "./activity-interceptors.js";
import type { HarnessBridgeActivities } from "./bridge-contracts.js";

export interface CreateHarnessBridgeWorkerOptions {
  activities: HarnessBridgeActivities;
  taskQueue?: string;
  address?: string;
  namespace?: string;
  identity?: string;
  interceptors?: SynthActivityInterceptorOptions;
  workflowInterceptorModules?: string[];
}

const DEFAULT_WORKFLOWS_PATH = fileURLToPath(new URL("./bridge-workflows.js", import.meta.url));
const DEFAULT_WORKFLOW_INTERCEPTOR_MODULE = fileURLToPath(
  new URL("./workflow-interceptors.js", import.meta.url),
);

export async function createHarnessBridgeWorker(
  options: CreateHarnessBridgeWorkerOptions,
): Promise<Worker> {
  const connection = await NativeConnection.connect(
    options.address ? { address: options.address } : undefined,
  );
  return Worker.create({
    connection,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
    workflowsPath: DEFAULT_WORKFLOWS_PATH,
    activities: options.activities,
    taskQueue: options.taskQueue ?? "synth-agent-runtime",
    interceptors: {
      activity: [createSynthActivityInterceptors(options.interceptors ?? {})],
      workflowModules: options.workflowInterceptorModules ?? [DEFAULT_WORKFLOW_INTERCEPTOR_MODULE],
    },
  });
}

export async function runHarnessBridgeWorker(
  options: CreateHarnessBridgeWorkerOptions,
): Promise<void> {
  const worker = await createHarnessBridgeWorker(options);
  await worker.run();
}
