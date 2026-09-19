import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createSynthActivityInterceptors } from "./activity-interceptors.js";
const DEFAULT_WORKFLOW_INTERCEPTOR_MODULE = fileURLToPath(new URL("./workflow-interceptors.js", import.meta.url));
export async function runTemporalWorker(options) {
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
