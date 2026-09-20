/**
 * Worker for the supervisor, on its OWN Temporal deployment.
 *
 * `SUPERVISOR_TEMPORAL_ADDRESS` defaults to 127.0.0.1:7244, deliberately not
 * the runtime-under-test's 7243: restarting the system under test must not take
 * its supervisor down with it. It uses no workflow interceptors from the
 * runtime integration, for the same reason.
 */
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createSupervisorActivities, type SupervisorActivityDeps } from "./activities.js";

export const SUPERVISOR_TASK_QUEUE = "synth-session-supervisor";
export const SUPERVISOR_WORKFLOW_TYPE = "superviseSessionWorkflow";

export function supervisorAddress(): string {
  return process.env.SUPERVISOR_TEMPORAL_ADDRESS ?? "127.0.0.1:7244";
}

export function supervisorNamespace(): string {
  return process.env.SUPERVISOR_TEMPORAL_NAMESPACE ?? "default";
}

export interface RunSupervisorWorkerOptions {
  address?: string;
  namespace?: string;
  taskQueue?: string;
  deps?: SupervisorActivityDeps;
}

export async function runSupervisorWorker(options: RunSupervisorWorkerOptions = {}): Promise<void> {
  const connection = await NativeConnection.connect({ address: options.address ?? supervisorAddress() });
  const worker = await Worker.create({
    connection,
    namespace: options.namespace ?? supervisorNamespace(),
    // Run via tsx from source, so the workflow entrypoint is the .ts file (the
    // same convention as the runtime integration's live scripts).
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities: createSupervisorActivities(options.deps),
    taskQueue: options.taskQueue ?? SUPERVISOR_TASK_QUEUE,
  });
  await worker.run();
}
