/**
 * A Temporal Schedule per session, so the supervisor is re-created if it dies.
 *
 * The check-ins themselves are durable timers INSIDE the workflow; the schedule
 * is what guarantees a supervisor exists at all across restarts. Overlap is
 * SKIP because the workflow is long-running: a schedule tick while it is alive
 * is a no-op, and a tick after it died starts a fresh one.
 */
import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import type { SupervisorInput } from "./contracts.js";
import { SUPERVISOR_TASK_QUEUE, SUPERVISOR_WORKFLOW_TYPE, supervisorAddress, supervisorNamespace } from "./worker.js";

export const supervisorWorkflowId = (sessionId: string): string => `supervisor/${sessionId}`;
export const supervisorScheduleId = (sessionId: string): string => `supervisor-schedule/${sessionId}`;

export interface EnsureScheduleOptions {
  cron?: string;
  address?: string;
  namespace?: string;
  client?: Client;
}

async function resolveClient(options: EnsureScheduleOptions): Promise<Client> {
  if (options.client) return options.client;
  const connection = await Connection.connect({ address: options.address ?? supervisorAddress() });
  return new Client({ connection, namespace: options.namespace ?? supervisorNamespace() });
}

/** Idempotent: creating a schedule that already exists is not an error. */
export async function ensureSupervisorSchedule(input: SupervisorInput, options: EnsureScheduleOptions = {}): Promise<{ scheduleId: string; created: boolean }> {
  const client = await resolveClient(options);
  const scheduleId = supervisorScheduleId(input.sessionId);
  try {
    await client.schedule.create({
      scheduleId,
      spec: { cronExpressions: [options.cron ?? "*/30 * * * *"] },
      action: {
        type: "startWorkflow",
        workflowType: SUPERVISOR_WORKFLOW_TYPE,
        taskQueue: SUPERVISOR_TASK_QUEUE,
        workflowId: supervisorWorkflowId(input.sessionId),
        args: [input],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
    return { scheduleId, created: true };
  } catch (error) {
    if (/already exists/i.test(error instanceof Error ? error.message : String(error))) return { scheduleId, created: false };
    throw error;
  }
}

/** Start the supervisor now instead of waiting for the next cron tick. */
export async function triggerSupervisorSchedule(sessionId: string, options: EnsureScheduleOptions = {}): Promise<void> {
  const client = await resolveClient(options);
  await client.schedule.getHandle(supervisorScheduleId(sessionId)).trigger();
}
