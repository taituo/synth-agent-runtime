/**
 * Operator entry: register a durable supervisor for one interactive session.
 *
 * This is the production path that replaces the hand-run monitor loop: run it
 * once and a Temporal Schedule keeps a supervisor alive (starting it now, and
 * re-creating it on the next tick if the workflow ever dies). It is idempotent:
 * re-running with the same `--session-id` returns the existing schedule rather
 * than creating a second one.
 *
 *   SUPERVISOR_TEMPORAL_ADDRESS=127.0.0.1:7244 \
 *   integrations/temporal/node_modules/.bin/tsx supervisor/supervise.ts \
 *     --session-id synth-1 --target synth-1:0.0 --check-in-ms 1800000
 *
 * Omit `--trigger` to wait for the next cron tick instead of starting at once.
 * Prints `{ scheduleId, created, workflowIdPrefix, triggered }` as JSON.
 */
import { DEFAULT_BLOCKED_THRESHOLD_MS, DEFAULT_CHECK_IN_MS, type SupervisorInput } from "./contracts.js";
import { ensureSupervisorSchedule, supervisorWorkflowId, triggerSupervisorSchedule } from "./schedule.js";
import { supervisorAddress, supervisorNamespace } from "./worker.js";

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(key, next);
      i++;
    } else {
      out.set(key, true);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const str = (name: string): string | undefined => {
  const value = args.get(name);
  return typeof value === "string" ? value : undefined;
};

const sessionId = str("session-id");
const target = str("target");
if (!sessionId || !target) {
  console.error("usage: supervise.ts --session-id <id> --target <tmux-target> [--check-in-ms N] [--blocked-threshold-ms N] [--cron EXPR] [--trigger]");
  process.exit(2);
}

const input: SupervisorInput = {
  sessionId,
  target,
  checkInMs: Number(str("check-in-ms") ?? DEFAULT_CHECK_IN_MS),
  blockedThresholdMs: Number(str("blocked-threshold-ms") ?? DEFAULT_BLOCKED_THRESHOLD_MS),
  ...(str("max-escalations") ? { maxEscalations: Number(str("max-escalations")) } : {}),
  ...(str("blocked-marker") ? { markers: { blocked: str("blocked-marker")! } } : {}),
};

const address = supervisorAddress();
const namespace = supervisorNamespace();
const cron = str("cron");
const schedule = await ensureSupervisorSchedule(input, { address, namespace, ...(cron ? { cron } : {}) });
let triggered = false;
if (args.has("trigger")) {
  await triggerSupervisorSchedule(sessionId, { address, namespace });
  triggered = true;
}

console.log(JSON.stringify({
  address,
  namespace,
  scheduleId: schedule.scheduleId,
  created: schedule.created,
  workflowIdPrefix: supervisorWorkflowId(sessionId),
  triggered,
}, null, 2));
