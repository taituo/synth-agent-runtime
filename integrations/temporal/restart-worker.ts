/**
 * Track 6 live proof: a worker is SIGKILLed mid-activity and restarted.
 *
 * The activity is retried after its heartbeat timeout (never a false success),
 * the workflow completes on the restarted worker, and the attempt log shows
 * attempt 1 was abandoned and attempt 2 recovered.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx restart-worker.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-restart-${Date.now()}`;
const attemptsFile = `/tmp/opencode/temporal-restart-attempts-${Date.now()}.txt`;
const childScript = fileURLToPath(new URL("./test/fixtures/restart-worker-child.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));
rmSync(attemptsFile, { force: true });

function spawnWorker(): ChildProcess {
  return spawn(tsxBin, [childScript], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, TEMPORAL_ADDRESS: address, TEMPORAL_NAMESPACE: namespace, TASK_QUEUE: taskQueue, ATTEMPTS_FILE: attemptsFile },
  });
}

const first = spawnWorker();
await sleep(2_500);

const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const handle = await client.workflow.start("restartProbeWorkflow", {
  taskQueue,
  workflowId: `restart-probe-${Date.now()}`,
});

await sleep(1_200); // attempt 1 is in flight on the first worker
try {
  process.kill(-first.pid!, "SIGKILL"); // kill the whole process group
} catch {
  first.kill("SIGKILL");
}
const second = spawnWorker();
await sleep(2_500);

const result = await Promise.race([handle.result(), sleep(30_000).then(() => "timeout")]);
const attempts = readFileSync(attemptsFile, "utf8").split("\n").filter(Boolean).map(Number);
const ok = result === "recovered" && attempts.includes(1) && attempts.some((attempt) => attempt >= 2);

console.log(JSON.stringify({ address, result, attempts, restartedWorkerRecovered: result === "recovered", ok }, null, 2));
try {
  process.kill(-second.pid!, "SIGKILL");
} catch {
  second.kill("SIGKILL");
}
await connection.close();
process.exit(ok ? 0 : 1);
