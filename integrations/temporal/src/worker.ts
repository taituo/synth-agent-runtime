import { fileURLToPath } from "node:url";
import { NativeConnection, Worker, type WorkerPlugin } from "@temporalio/worker";
import { createSynthActivityInterceptors, type SynthActivityInterceptorOptions } from "./activity-interceptors.js";
import type { AgentActivities, GraphActivities } from "./contracts.js";

export interface RunTemporalWorkerOptions {
  workflowsPath: string;
  /** `graphActivity` is optional; it is only needed by graphs with activity nodes. */
  activities: AgentActivities & Partial<GraphActivities>;
  /**
   * Worker plugins, e.g. `new OpenTelemetryPlugin(...)` from
   * `@temporalio/interceptors-opentelemetry`, which adds client/workflow/activity
   * tracing. Plugins are applied by `Worker.create` on top of this package's own
   * interceptors.
   */
  plugins?: WorkerPlugin[];
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

/** Create the worker without running it (callers that need it in-process). */
export async function createTemporalWorker(options: RunTemporalWorkerOptions): Promise<Worker> {
  const connection = await NativeConnection.connect(options.address ? { address: options.address } : undefined);
  return Worker.create({
    connection,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
    workflowsPath: options.workflowsPath,
    activities: options.activities,
    taskQueue: options.taskQueue ?? "synth-agent-runtime",
    ...(options.plugins ? { plugins: options.plugins } : {}),
    interceptors: {
      activity: [createSynthActivityInterceptors(options.interceptors ?? {})],
      workflowModules: options.workflowInterceptorModules ?? [DEFAULT_WORKFLOW_INTERCEPTOR_MODULE],
    },
  });
}

export async function runTemporalWorker(options: RunTemporalWorkerOptions): Promise<void> {
  const worker = await createTemporalWorker(options);
  await worker.run();
}
