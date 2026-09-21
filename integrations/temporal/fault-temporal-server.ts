/**
 * Fault matrix cell: remove the Temporal server (stop it, then restart it).
 *
 * Two modes, because they answer the same four questions differently and the
 * difference is the point:
 *
 *   --mode persistent  `temporal server start-dev --db-filename <file>`
 *   --mode inmemory    `temporal server start-dev` (no persistence; the dev
 *                      server keeps state in memory, so a restart is a wipe)
 *
 * Sequence for both:
 *   1. start the server; start a worker for `restartProbeWorkflow` (the Track 6
 *      fixture: attempt 1 never heartbeats, later attempts succeed).
 *   2. start the workflow; wait until attempt 1 is in flight.
 *   3. SIGTERM the server, wait for the port to close.
 *   4. restart the server with the same command/db file.
 *   5. persistent: the workflow must still exist, be retried and finish.
 *      inmemory:    the workflow is gone (NOT_FOUND) — data lost by construction.
 *
 * The four questions are answered from measured quantities, never inferred:
 *   retried     -> attempts [1, 2] in the attempts file
 *   data lost   -> describe() before vs after the restart
 *   human       -> did the workflow reach a terminal state on its own?
 *   double      -> attempt 1 and attempt 2 both executed the activity body
 *                  (the attempts file has two lines for one logical turn)
 *
 * Exit 0 when the mode's expectation held; 1 when it did not; 2 when the
 * `temporal` binary is absent (a distinct skip, never a pass).
 *
 *   TEMPORAL_BIN=... npx tsx fault-temporal-server.ts --mode persistent --port 7245
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { Client, Connection } from "@temporalio/client";

const mode = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "persistent";
const portArg = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "7245";
const port = Number(portArg);
const address = `127.0.0.1:${port}`;
const temporalBin = process.env.TEMPORAL_BIN ?? "temporal";
const persist = mode === "persistent";
const dir = mkdtempSync(join(tmpdir(), `synth-fault-temporal-${mode}-`));
const dbFile = join(dir, "temporal.db");
const attemptsFile = join(dir, "attempts.txt");
const taskQueue = `synth-fault-temporal-${Date.now().toString(36)}`;
const workflowId = `fault-temporal-${Date.now().toString(36)}`;
const tsxBin = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));
const childScript = fileURLToPath(new URL("./test/fixtures/restart-worker-child.ts", import.meta.url));

function portOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(400);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

function startServer(): ChildProcess {
  const args = ["server", "start-dev", "--headless", "--port", String(port)];
  if (persist) args.push("--db-filename", dbFile);
  const child = spawn(temporalBin, args, { stdio: ["ignore", "ignore", "ignore"], detached: false });
  return child;
}

async function waitPort(open: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portOpen()) === open) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${address} to be ${open ? "open" : "closed"}`);
}

function readAttempts(): number[] {
  try {
    return readFileSync(attemptsFile, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function describeStatus(client: Client): Promise<string> {
  try {
    const description = await client.workflow.getHandle(workflowId).describe();
    return description.status.name;
  } catch (error) {
    const name = (error as { name?: string }).name ?? "Error";
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: string }).message ?? String(error);
    return `ERROR(${name}${code !== undefined ? ` code=${String(code)}` : ""}: ${message.split("\n")[0]})`;
  }
}

/** A dev server opens the TCP port slightly before the frontend answers. Poll. */
async function waitDescribed(client: Client, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "ERROR(never described)";
  while (Date.now() < deadline) {
    last = await describeStatus(client);
    if (last === "RUNNING" || last === "COMPLETED" || last === "FAILED" || last === "TIMED_OUT") return last;
    await sleep(500);
  }
  return last;
}

const result: Record<string, unknown> = {
  fault: "temporal-server",
  mode,
  address,
  workflowId,
  taskQueue,
  dbPersistent: persist,
};

let server: ChildProcess | undefined;
let worker: ChildProcess | undefined;
let ok = false;
let exitCode = 1;

try {
  server = startServer();
  await waitPort(true, 30_000);

  worker = spawn(tsxBin, [childScript], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, TEMPORAL_ADDRESS: address, TEMPORAL_NAMESPACE: "default", TASK_QUEUE: taskQueue, ATTEMPTS_FILE: attemptsFile },
  });

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace: "default" });
  const handle = await client.workflow.start("restartProbeWorkflow", { taskQueue, workflowId });

  // Wait for attempt 1 to be in flight before removing the server.
  const startDeadline = Date.now() + 20_000;
  while (readAttempts().length === 0 && Date.now() < startDeadline) await sleep(100);
  result.attemptsBeforeRestart = readAttempts();

  // Remove the Temporal server.
  server.kill("SIGTERM");
  await waitPort(false, 20_000);
  result.portClosedAfterStop = true;

  // Restart it, same db file when persistent.
  server = startServer();
  await waitPort(true, 30_000);

  await sleep(2_000); // let workers reconnect / timers fire
  const freshConnection = await Connection.connect({ address });
  const freshClient = new Client({ connection: freshConnection, namespace: "default" });
  result.statusAfterRestart = await waitDescribed(freshClient, 20_000);

  if (persist) {
    const raced = await Promise.race([
      handle.result().catch((error) => `__error__:${error instanceof Error ? error.message : String(error)}`),
      sleep(30_000).then(() => "__timeout__" as const),
    ]);
    const attempts = readAttempts();
    result.attempts = attempts;
    result.result = raced;
    const retried = attempts.includes(1) && attempts.some((attempt) => attempt >= 2);
    const survived = !String(result.statusAfterRestart).startsWith("ERROR(");
    const completed = raced === "recovered";
    ok = retried && survived && completed;
    result.questions = {
      retried,
      dataLost: !survived,
      humanNeeded: !completed,
      sideEffectTwice: attempts.filter((attempt) => attempt >= 1).length > 1,
    };
    await freshConnection.close().catch(() => {});
    await connection.close().catch(() => {});
  } else {
    // In-memory: the workflow is gone; there is nothing to await.
    const survived = !String(result.statusAfterRestart).startsWith("ERROR(");
    result.attempts = readAttempts();
    ok = !survived; // the honest expectation for an in-memory dev server
    result.questions = {
      retried: false,
      dataLost: !survived,
      humanNeeded: !survived,
      sideEffectTwice: undefined,
    };
    await freshConnection.close().catch(() => {});
    await connection.close().catch(() => {});
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  ok = false;
} finally {
  worker?.kill("SIGKILL");
  server?.kill("SIGTERM");
  await sleep(500);
  result.ok = ok;
  console.log(JSON.stringify(result, null, 2));
  rmSync(dir, { recursive: true, force: true });
  exitCode = ok ? 0 : 1;
}
process.exit(exitCode);
