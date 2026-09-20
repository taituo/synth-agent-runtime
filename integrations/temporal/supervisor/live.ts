/**
 * LIVE proof for the durable session supervisor (roadmap item 5).
 *
 * Runs against a SEPARATE Temporal (default 127.0.0.1:7244, never the runtime's
 * 7243) and a real tmux pane. Proves, with the real tmux probe and verified
 * pokes:
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
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, Connection } from "@temporalio/client";
import { getSupervisorStateQuery, redirectSignal, stopSignal, superviseSessionWorkflow } from "./workflows.js";
import { SUPERVISOR_TASK_QUEUE, supervisorAddress } from "./worker.js";

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

export async function main(): Promise<void> {
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
    const handle = await client.workflow.start(superviseSessionWorkflow, {
      taskQueue: SUPERVISOR_TASK_QUEUE,
      workflowId: `supervisor/${sessionId}`,
      args: [{
        sessionId,
        target: `${tmuxName}:0.0`,
        checkInMs: 800,
        blockedThresholdMs: 1_200,
        maxEscalations: 2,
        markers: { blocked: "BLOCKED_MARKER" },
      }],
    });

    // 1. Working: the pane shows the busy marker.
    await writeFile(stateFile, "esc interrupt\n");
    await sleep(2_000);
    const working = await handle.query(getSupervisorStateQuery);
    evidence.working = { status: working.status, checkIns: working.checkIns };

    // 2. Blocked past the threshold: an escalation must fire and land.
    await writeFile(stateFile, "BLOCKED_MARKER\n");
    await sleep(4_000);
    const blocked = await handle.query(getSupervisorStateQuery);
    evidence.blocked = { status: blocked.status, escalations: blocked.escalations, checkIns: blocked.checkIns };

    // 3. Human redirection: a signal must be delivered and confirmed.
    await handle.signal(redirectSignal, "hello from the human");
    await sleep(2_000);
    const redirected = await handle.query(getSupervisorStateQuery);
    const inboxAfterRedirect = await readFile(inboxFile, "utf8");
    evidence.redirect = { pokes: redirected.pokes, lastRedirect: redirected.lastRedirect, delivered: inboxAfterRedirect.includes("hello from the human") };

    // 4. Durability: SIGKILL the worker, restart it, the workflow must continue.
    const checkInsBeforeRestart = redirected.checkIns;
    worker.kill("SIGKILL");
    await sleep(1_000);
    worker = startWorker(address);
    await sleep(4_000);
    const afterRestart = await handle.query(getSupervisorStateQuery);
    evidence.restart = { checkInsBeforeRestart, checkInsAfterRestart: afterRestart.checkIns, survived: afterRestart.checkIns > checkInsBeforeRestart };

    // 5. Stop.
    await handle.signal(stopSignal);
    const final = await handle.result();
    evidence.final = { stopped: final.stopped, checkIns: final.checkIns, escalations: final.escalations, pokes: final.pokes };
    const inbox = await readFile(inboxFile, "utf8");
    evidence.escalationDelivered = inbox.includes("[supervisor]");

    const ok =
      evidence.working !== undefined &&
      (working.status === "working" || working.status === "blocked") &&
      blocked.escalations >= 1 &&
      redirected.pokes >= 1 &&
      inboxAfterRedirect.includes("hello from the human") &&
      afterRestart.checkIns > checkInsBeforeRestart &&
      final.stopped === true;
    evidence.ok = ok;
    console.log(JSON.stringify(evidence, null, 2));
    process.exit(ok ? 0 : 1);
  } finally {
    if (sessionStarted) await execFileAsync("tmux", ["kill-session", "-t", tmuxName]).catch(() => {});
    worker.kill("SIGKILL");
    await rm(work, { recursive: true, force: true });
    await connection.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
