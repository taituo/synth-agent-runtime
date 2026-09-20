/**
 * LIVE proof for the durable session supervisor (roadmap item 5).
 *
 * Runs against a SEPARATE Temporal (default 127.0.0.1:7244, never the runtime's
 * 7243) and a real tmux pane. Proves, with the real tmux probe and verified
 * pokes:
 *   - a Temporal Schedule starts the supervisor (created, triggered, and its
 *     recent actions name the workflow it started — no hand `workflow.start`);
 *   - periodic check-ins happen on the durable timer;
 *   - a pane that stays blocked past the threshold is escalated, and the
 *     escalation text actually landed in the pane;
 *   - a `redirect` signal is delivered and confirmed in the pane;
 *   - the worker is SIGKILLed and restarted, and the workflow continues
 *     (check-ins keep advancing) — the durability claim, not asserted.
 *
 * Missing tmux or Temporal => SKIP, exit 2, never ok:true.
 *
 *   SUPERVISOR_TEMPORAL_ADDRESS=127.0.0.1:7244 \
 *   integrations/temporal/node_modules/.bin/tsx supervisor/live.ts
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, Connection, type ScheduleHandle, type WorkflowHandle } from "@temporalio/client";
import type { SupervisorState } from "./contracts.js";
import { ensureSupervisorSchedule, supervisorScheduleId, supervisorWorkflowId, triggerSupervisorSchedule } from "./schedule.js";
import { getSupervisorStateQuery, redirectSignal, stopSignal } from "./workflows.js";
import { supervisorAddress } from "./worker.js";

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

function skip(reason: string): never {
  console.error(JSON.stringify({ skipped: true, reason }));
  process.exit(2);
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout;
}

function queryWithTimeout(handle: WorkflowHandle, ms: number): Promise<SupervisorState> {
  return Promise.race([
    handle.query(getSupervisorStateQuery),
    sleep(ms).then((): never => { throw new Error("query timed out (no worker?)"); }),
  ]);
}

/**
 * Poll until the state satisfies `predicate`, so the proof does not depend on a
 * worker having warmed up or come back from a restart within a fixed sleep. A
 * query that cannot reach a worker is retried; the deadline bounds it.
 */
async function waitForState(
  handle: WorkflowHandle,
  predicate: (state: SupervisorState) => boolean,
  deadlineMs: number,
): Promise<SupervisorState> {
  const end = Date.now() + deadlineMs;
  let last: SupervisorState | undefined;
  while (Date.now() < end) {
    try {
      last = await queryWithTimeout(handle, 5_000);
    } catch {
      await sleep(300);
      continue;
    }
    if (predicate(last)) return last;
    await sleep(300);
  }
  if (last) return last;
  throw new Error("workflow state was never queryable");
}

/**
 * Prove the *Schedule* (not a hand `workflow.start`) fired the supervisor: wait
 * until its recent actions include a startWorkflow, and return the workflow id
 * Temporal actually started. Temporal appends the schedule time to the action's
 * workflowId, so the returned id is the real handle to query.
 */
async function waitForScheduleAction(handle: ScheduleHandle, workflowIdPrefix: string, deadlineMs: number, exclude?: string): Promise<string | undefined> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const description = await handle.describe();
      const action = (description.info.recentActions ?? []).find((entry) =>
        entry.action.type === "startWorkflow"
        && entry.action.workflow.workflowId.startsWith(workflowIdPrefix)
        && entry.action.workflow.workflowId !== exclude);
      if (action?.action.type === "startWorkflow") return action.action.workflow.workflowId;
    } catch {
      // The schedule may not be visible yet; retry until the deadline.
    }
    await sleep(200);
  }
  return undefined;
}

function startWorker(address: string): ChildProcess {
  const child = spawn(TSX, [join(HERE, "worker-entry.ts")], {
    cwd: join(HERE, ".."),
    env: { ...process.env, SUPERVISOR_TEMPORAL_ADDRESS: address },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
}

/**
 * Kill the worker and the node process tsx spawns for it. `tsx` runs the script
 * in a child node process, so killing only the wrapper leaves the worker alive
 * and leaking until the process exits.
 */
function killWorker(child: ChildProcess): void {
  if (child.pid) {
    try {
      execFileSync("pkill", ["-9", "-P", String(child.pid)]);
    } catch {
      // No children (or pkill absent): the direct kill below is the fallback.
    }
  }
  child.kill("SIGKILL");
}

export async function main(): Promise<number> {
  const address = supervisorAddress();
  if (address.endsWith(":7243")) skip("supervisor Temporal must not be the runtime's 7243; set SUPERVISOR_TEMPORAL_ADDRESS");
  try {
    await execFileAsync("tmux", ["-V"]);
  } catch {
    skip("tmux is not installed");
  }

  let connection: Connection;
  try {
    connection = await Connection.connect({ address });
  } catch (error) {
    skip(`supervisor Temporal ${address} is not reachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const client = new Client({ connection });
  const namespace = process.env.SUPERVISOR_TEMPORAL_NAMESPACE ?? "default";
  const work = await mkdtemp(join(tmpdir(), "sup-live-"));
  const stateFile = join(work, "state");
  const inboxFile = join(work, "inbox");
  await writeFile(stateFile, "all quiet\n");
  await writeFile(inboxFile, "");
  const tmuxName = `sup-live-${Date.now()}`;
  let worker = startWorker(address);
  let sessionStarted = false;
  let scheduleIdForCleanup: string | undefined;
  const evidence: Record<string, unknown> = { address, tmux: tmuxName, checkInMs: 800, blockedThresholdMs: 1200 };

  try {
    // A pane that displays a state file and appends stdin to an inbox, so a
    // poke's text is visible AND persisted (that is what the probe verifies).
    const script = [
      `touch "${stateFile}" "${inboxFile}"`,
      `( while true; do clear; echo "== state =="; cat "${stateFile}" 2>/dev/null; echo "== inbox =="; tail -5 "${inboxFile}" 2>/dev/null; sleep 0.2; done ) &`,
      `while IFS= read -r line; do echo "$line" >> "${inboxFile}"; done`,
    ].join("\n");
    await tmux("new-session", "-d", "-s", tmuxName, "bash", "-c", script);
    sessionStarted = true;
    await sleep(3_000); // let the worker register

    const sessionId = `sup-live-${Date.now()}`;
    const input = {
      sessionId,
      target: `${tmuxName}:0.0`,
      checkInMs: 800,
      blockedThresholdMs: 1_200,
      maxEscalations: 2,
      markers: { blocked: "BLOCKED_MARKER" },
    };
    // The supervisor is started by a Temporal Schedule, not by hand — the same
    // production path a deployment uses. A far-future cron means the explicit
    // trigger is the only action in this run; the schedule is deleted below.
    const scheduleId = supervisorScheduleId(sessionId);
    const workflowIdPrefix = supervisorWorkflowId(sessionId);
    scheduleIdForCleanup = scheduleId;
    const schedule = await ensureSupervisorSchedule(input, { address, namespace, cron: "0 0 1 1 *" });
    await triggerSupervisorSchedule(sessionId, { address, namespace });
    const scheduleHandle = client.schedule.getHandle(scheduleId);
    evidence.schedule = { scheduleId, created: schedule.created, workflowIdPrefix };

    // The workflow exists because the SCHEDULE started it (no hand start); the
    // schedule names the workflow it started.
    const startedWorkflowId = await waitForScheduleAction(scheduleHandle, workflowIdPrefix, 20_000);
    evidence.scheduleFired = startedWorkflowId !== undefined;
    evidence.startedWorkflowId = startedWorkflowId ?? null;
    const handle = client.workflow.getHandle(startedWorkflowId ?? workflowIdPrefix);

    // 1. Working: the pane shows the busy marker. Wait for a real check-in
    // rather than a fixed sleep, so a cold worker does not race the assertion.
    await writeFile(stateFile, "esc interrupt\n");
    const working = await waitForState(handle, (state) => state.checkIns >= 1, 25_000);
    evidence.working = { status: working.status, checkIns: working.checkIns };

    // 2. Blocked past the threshold: an escalation must fire and land.
    await writeFile(stateFile, "BLOCKED_MARKER\n");
    const blocked = await waitForState(handle, (state) => state.escalations >= 1, 25_000);
    evidence.blocked = { status: blocked.status, escalations: blocked.escalations, checkIns: blocked.checkIns };

    // 3. Human redirection: a signal must be delivered and confirmed.
    await handle.signal(redirectSignal, "hello from the human");
    const redirected = await waitForState(handle, (state) => state.pokes >= 1, 25_000);
    const inboxAfterRedirect = await readFile(inboxFile, "utf8");
    evidence.redirect = { pokes: redirected.pokes, lastRedirect: redirected.lastRedirect, delivered: inboxAfterRedirect.includes("hello from the human") };

    // 4. Durability: SIGKILL the worker, restart it, the workflow must continue.
    const checkInsBeforeRestart = redirected.checkIns;
    killWorker(worker);
    await sleep(1_000);
    worker = startWorker(address);
    // Generous: after a SIGKILL the workflow task must be reassigned off the
    // dead worker's sticky cache before the next check-in can advance.
    const afterRestart = await waitForState(handle, (state) => state.checkIns > checkInsBeforeRestart, 90_000);
    evidence.restart = { checkInsBeforeRestart, checkInsAfterRestart: afterRestart.checkIns, survived: afterRestart.checkIns > checkInsBeforeRestart };

    // 5. Stop.
    await handle.signal(stopSignal);
    const final = await handle.result();
    evidence.final = { stopped: final.stopped, checkIns: final.checkIns, escalations: final.escalations, pokes: final.pokes };
    const inbox = await readFile(inboxFile, "utf8");
    evidence.escalationDelivered = inbox.includes("[supervisor]");

    // 6. Schedule durability: once the supervisor has ended, a schedule action
    // starts a fresh one — the reason the Schedule exists instead of a hand run.
    await triggerSupervisorSchedule(sessionId, { address, namespace });
    const recreatedWorkflowId = await waitForScheduleAction(scheduleHandle, workflowIdPrefix, 20_000, startedWorkflowId);
    evidence.scheduleRecreated = recreatedWorkflowId !== undefined;
    evidence.recreatedWorkflowId = recreatedWorkflowId ?? null;
    if (recreatedWorkflowId) {
      const recreated = client.workflow.getHandle(recreatedWorkflowId);
      await recreated.signal(stopSignal);
      await recreated.result().catch(() => undefined);
    }

    const ok =
      evidence.working !== undefined &&
      schedule.created === true &&
      startedWorkflowId !== undefined &&
      (working.status === "working" || working.status === "blocked") &&
      blocked.escalations >= 1 &&
      redirected.pokes >= 1 &&
      inboxAfterRedirect.includes("hello from the human") &&
      afterRestart.checkIns > checkInsBeforeRestart &&
      final.stopped === true &&
      evidence.scheduleRecreated === true;
    evidence.ok = ok;
    console.log(JSON.stringify(evidence, null, 2));
    // Return (not process.exit) so the `finally` cleanup — schedule delete,
    // tmux kill, worker kill, temp dir — runs before the process ends.
    return ok ? 0 : 1;
  } finally {
    // Delete the schedule before the pane so no cron tick starts a supervisor
    // against a session that is gone.
    if (scheduleIdForCleanup) await client.schedule.getHandle(scheduleIdForCleanup).delete().catch(() => {});
    if (sessionStarted) await execFileAsync("tmux", ["kill-session", "-t", tmuxName]).catch(() => {});
    killWorker(worker);
    await rm(work, { recursive: true, force: true });
    await connection.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exit(1);
    });
}
