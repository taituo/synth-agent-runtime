import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createSynthActivityInterceptors, type SynthActivityInterceptorOptions } from "./activity-interceptors.js";
import type { AgentActivities, GraphActivities } from "./contracts.js";

export interface RunTemporalWorkerOptions {
  workflowsPath: string;
  /** `graphActivity` is optional; it is only needed by graphs with activity nodes. */
  activities: AgentActivities & Partial<GraphActivities>;
  taskQueue?: string;
  address?: string;
  namespace?: string;
  identity?: string;
  /** Activity interceptor options: trace sink, trace id, retry policy. */
  interceptors?: SynthActivityInterceptorOptions;
  /**
   * Modules exporting workflow interceptors. Defaults to this package's own
   * `workflow-interceptors` module; pass `[]` to disable workflow interceptors.
   */
  workflowInterceptorModules?: string[];
}

const DEFAULT_WORKFLOW_INTERCEPTOR_MODULE = fileURLToPath(
  new URL("./workflow-interceptors.js", import.meta.url),
);

export async function runTemporalWorker(options: RunTemporalWorkerOptions): Promise<void> {
  const connection = await NativeConnection.connect(options.address ? { address: options.address } : undefined);
  const worker = await Worker.create({
    connection,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
    workflowsPath: options.workflowsPath,
    activities: options.activities,
    taskQueue: options.taskQueue ?? "synth-agent-runtime",
    interceptors: {
      activity: [createSynthActivityInterceptors(options.interceptors ?? {})],
      workflowModules: options.workflowInterceptorModules ?? [DEFAULT_WORKFLOW_INTERCEPTOR_MODULE],
    },
  });
  await worker.run();
}
