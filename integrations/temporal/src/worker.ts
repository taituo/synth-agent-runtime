import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { NativeConnection, Worker, type WorkerDeploymentOptions, type WorkerPlugin } from "@temporalio/worker";
import { createSynthActivityInterceptors, type SynthActivityInterceptorOptions } from "./activity-interceptors.js";
import type { AgentActivities, GraphActivities } from "./contracts.js";
import type { GymActivities } from "./gym-contracts.js";

export interface RunTemporalWorkerOptions {
  workflowsPath: string;
  /**
   * The activity surface this worker serves. `graphActivity` is optional (only
   * graphs with activity nodes need it); the gym activities are optional so the
   * production entry can register the runtime and gym paths on one worker while
   * the gym-only entry still type-checks.
   */
  activities: AgentActivities & Partial<GraphActivities> & Partial<GymActivities>;
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
  /** Native Temporal worker concurrency: max activity task executions. */
  maxConcurrentActivityTaskExecutions?: number;
  /** Native Temporal worker concurrency: max workflow task executions. */
  maxConcurrentWorkflowTaskExecutions?: number;
  /** Build ID for classic Build-ID versioning (pair with `useVersioning`). */
  buildId?: string;
  /** Enable classic Build-ID worker versioning. */
  useVersioning?: boolean;
  /** Worker Deployment versioning (preview): named deployment + build id. */
  workerDeploymentOptions?: WorkerDeploymentOptions;
  /** Grace period for in-flight tasks on shutdown (e.g. "30 seconds"). */
  shutdownGraceTime?: string;
  /**
   * When set, serve `GET /healthz` (200 ready / 503 draining) so a Kubernetes
   * readiness/liveness probe reflects the worker, not just the process.
   */
  healthPort?: number;
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
    ...(options.maxConcurrentActivityTaskExecutions !== undefined
      ? { maxConcurrentActivityTaskExecutions: options.maxConcurrentActivityTaskExecutions }
      : {}),
    ...(options.maxConcurrentWorkflowTaskExecutions !== undefined
      ? { maxConcurrentWorkflowTaskExecutions: options.maxConcurrentWorkflowTaskExecutions }
      : {}),
    ...(options.workerDeploymentOptions ? { workerDeploymentOptions: options.workerDeploymentOptions } : {}),
    ...(options.buildId ? { buildId: options.buildId } : {}),
    ...(options.useVersioning !== undefined ? { useVersioning: options.useVersioning } : {}),
    ...(options.shutdownGraceTime ? { shutdownGraceTime: options.shutdownGraceTime } : {}),
    ...(options.plugins ? { plugins: options.plugins } : {}),
    interceptors: {
      activity: [createSynthActivityInterceptors(options.interceptors ?? {})],
      workflowModules: options.workflowInterceptorModules ?? [DEFAULT_WORKFLOW_INTERCEPTOR_MODULE],
    },
  });
}

/**
 * Minimal probe surface for a worker that has no HTTP API of its own: 200 while
 * the worker should receive tasks, 503 once it is draining on SIGTERM. Kept
 * here (not in the entry) so every worker startup path gets the same behaviour.
 */
function startHealthServer(port: number): { setReady(ready: boolean): void; close(): void } {
  let ready = true;
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(ready ? 200 : 503, { "content-type": "text/plain" });
      response.end(ready ? "ok" : "draining");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(port, "0.0.0.0");
  return {
    setReady: (value) => {
      ready = value;
    },
    close: () => server.close(),
  };
}

/**
 * Run until SIGTERM/SIGINT, then shut down gracefully: stop polling, let
 * in-flight activities finish within `shutdownGraceTime` (Temporal default 30s),
 * and only then exit. A replica killed before it can finish is not a data-loss
 * problem — Temporal retries the in-flight activity on another replica — but a
 * graceful drain avoids the retry under normal rolling deploys.
 */
export async function runTemporalWorker(options: RunTemporalWorkerOptions): Promise<void> {
  const worker = await createTemporalWorker(options);
  const health = options.healthPort !== undefined ? startHealthServer(options.healthPort) : undefined;
  const shutdown = new Promise<void>((resolve) => {
    const onSignal = (): void => {
      health?.setReady(false);
      resolve();
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  });
  try {
    await worker.runUntil(shutdown);
  } finally {
    health?.close();
  }
}
