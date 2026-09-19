import { NativeConnection, Worker } from "@temporalio/worker";
import type { AgentActivities } from "./contracts.js";

export async function runTemporalWorker(options: {
  workflowsPath: string;
  activities: AgentActivities;
  taskQueue?: string;
  address?: string;
}): Promise<void> {
  const connection = await NativeConnection.connect(options.address ? { address: options.address } : undefined);
  const worker = await Worker.create({
    connection,
    workflowsPath: options.workflowsPath,
    activities: options.activities,
    taskQueue: options.taskQueue ?? "synth-agent-runtime",
  });
  await worker.run();
}
