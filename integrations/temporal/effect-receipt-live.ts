/**
 * Live proof: effect receipts persist in Temporal activity state, so a retried
 * activity dedupes a committed effect by `effect.id` instead of re-executing it.
 *
 * A one-turn graph runs the shipped `runTurn` activity with the shipped rung
 * path: `createGatewayRunTurn` resolves the receipt store from the activity
 * context (`TemporalActivityStateStore.fromCurrentActivity()`) and hands it to
 * the rung, whose broker persists a receipt on commit.
 *
 * The fake gateway asks for two `workspace.write` tool calls. The counting
 * executor throws on the SECOND call, so the activity fails AFTER the first
 * effect is committed; Temporal retries it. On the retry the first effect must
 * be deduped (executor not called again) and the second receipt must resolve as
 * `started` (uncertain) rather than be replayed.
 *
 * Discriminating quantities:
 *   - `attempts` = [1, 2] (a real Temporal activity retry happened);
 *   - attempt 1's heartbeat details are empty and attempt 2's carry
 *     `write_file:0 = committed` (the receipt crossed the retry in Temporal);
 *   - the first effect was executed exactly once across both attempts.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx effect-receipt-live.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { runGraphWorkflow } from "./src/graph-workflow.js";
import type { GraphStep } from "./src/graph.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-effect-receipt-${Date.now()}`;
const eventLog = `/tmp/opencode/effect-receipt-events-${Date.now()}.jsonl`;
const agentId = `agt_receipt_${Date.now()}`;
const childScript = fileURLToPath(new URL("./test/fixtures/effect-receipt-worker.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));
rmSync(eventLog, { force: true });

interface LogEntry { event: string; attempt?: number; id?: string; seed?: string[] }

function readLog(): LogEntry[] {
  try {
    return readFileSync(eventLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
  } catch {
    return [];
  }
}

function spawnWorker(): ChildProcess {
  return spawn(tsxBin, [childScript], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, TEMPORAL_ADDRESS: address, TEMPORAL_NAMESPACE: namespace, TASK_QUEUE: taskQueue, EVENT_LOG: eventLog },
  });
}

function killWorker(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

const worker = spawnWorker();
await sleep(2_500);

const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const graph: GraphStep = {
  id: "root",
  kind: "turn",
  agentId,
  messages: [{ id: "m1", role: "human", text: "write two files", createdAt: 1 }],
  config: {
    systemPrompt: "You edit files.",
    tools: [{ name: "write_file", effect: "workspace.write" }],
    rung: { kind: "synthetic" },
  },
};
const handle = await client.workflow.start(runGraphWorkflow, {
  taskQueue,
  workflowId: `effect-receipt/${Date.now()}`,
  args: [{ graph }],
});
const result = await Promise.race([handle.result(), sleep(60_000).then(() => undefined)]);

const log = readLog();
const attempts = log.filter((entry) => entry.event === "attempt");
const firstEffectId = `${agentId}:write_file:0`;
const firstExecutions = log.filter((entry) => entry.event === "execute" && entry.id === firstEffectId);
const attempt1Seed = attempts.find((entry) => entry.attempt === 1)?.seed ?? [];
const attempt2Seed = attempts.find((entry) => entry.attempt === 2)?.seed ?? [];

const ok =
  result?.status === "completed"
  && attempts.map((entry) => entry.attempt).join(",") === "1,2"
  && attempt1Seed.length === 0
  && attempt2Seed.includes(`${firstEffectId}:committed`)
  && firstExecutions.length === 1;

console.log(JSON.stringify({
  address,
  taskQueue,
  status: result?.status ?? "no-result",
  attempts: attempts.map((entry) => entry.attempt),
  attempt1Seed,
  attempt2Seed,
  firstEffectId,
  firstEffectExecutions: firstExecutions.length,
  firstEffectExecutionAttempts: firstExecutions.map((entry) => entry.attempt),
  executions: log.filter((entry) => entry.event === "execute").map((entry) => `${entry.id}#${entry.attempt}`),
  ok,
}, null, 2));

killWorker(worker);
await connection.close();
process.exit(ok ? 0 : 1);
