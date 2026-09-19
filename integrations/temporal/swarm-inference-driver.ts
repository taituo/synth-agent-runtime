/**
 * REAL-inference swarm: three concurrent durable agents, each fed its own typed
 * event stream, each turn answered by a real model through an OpenAI-compatible
 * gateway (no stubs).
 *
 * What it proves, beyond the stub swarm in `swarm-driver.ts`:
 *   - a real, slow (reasoning) model can sit behind a Temporal activity without
 *     the workflow's heartbeat timeout killing it;
 *   - events arriving while a turn is in flight are batched into the next turn
 *     and none are lost, duplicated or reordered (checked against the script);
 *   - the model's per-event classification is scored against the planted `kind`
 *     the model never saw;
 *   - correlation ids still never cross-contaminate between agents.
 *
 * Requires a Temporal dev server and a reachable gateway:
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 GATEWAY_URL=http://127.0.0.1:8787 \
 *   GATEWAY_MODEL=muse-spark-1.3-contributor npx tsx swarm-inference-driver.ts
 *
 * Optional: GATEWAY_API_KEY, GATEWAY_TIMEOUT_MS (per model call), SWARM_TIMEOUT_MS (per agent).
 * Point GATEWAY_URL at `flaky-gateway.ts` to inject real HTTP faults.
 *
 * Cost note: 3 agents x 4 events => roughly 6-9 model calls (batching makes the
 * count vary), at ~10-20s each for a reasoning model.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { createGatewayRunTurn, type GatewayTurnRecord } from "./src/gateway-run-turn.js";
import {
  INFERENCE_SWARM_SCRIPTS,
  logCorrelationViolations,
  scoreAgainstScript,
  swarmIsolationViolations,
  type ScriptedEvent,
} from "./event-script.js";
import { startEventRunner, type EventRunner } from "./event-runner.js";

/** Overall accuracy needed to pass. A real model can disagree; this is scored, not assumed. */
export const ACCURACY_GATE = 0.75;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function preflight(baseUrl: string, model: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(8000) });
  } catch (error) {
    throw new Error(`gateway ${baseUrl} is not reachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`gateway ${baseUrl} /v1/models returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id: string }> };
  const ids = (body.data ?? []).map((entry) => entry.id);
  if (!ids.includes(model)) throw new Error(`gateway does not list model ${model}; it lists: ${ids.join(", ") || "(none)"}`);
}

async function driveAgent(
  runner: EventRunner,
  records: GatewayTurnRecord[],
  agentId: string,
  script: readonly ScriptedEvent[],
  timeoutMs: number,
) {
  const handle = await runner.client.workflow.start(durableAgentWorkflow, {
    taskQueue: runner.taskQueue,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now() }],
  });

  for (const event of script) {
    if (event.delayMs > 0) await sleep(event.delayMs);
    await handle.signal(sendMessage, {
      id: `${agentId}-${event.kind}-${Math.random().toString(36).slice(2)}`,
      role: "human",
      text: event.text,
      createdAt: Date.now(),
      kind: event.kind,
    });
  }

  const classifiedFor = () =>
    records.filter((record) => record.agentId === agentId).reduce((sum, record) => sum + record.classifications.length, 0);

  // The workflow ends early (status "failed") if an activity exhausts its
  // retries, so also stop waiting when the workflow itself finishes.
  let workflowEnded = false;
  void handle.result().then(
    () => { workflowEnded = true; },
    () => { workflowEnded = true; },
  );
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  while (classifiedFor() < script.length && !workflowEnded) {
    if (Date.now() > deadline) { timedOut = true; break; }
    await sleep(200);
  }

  await sleep(300); // let the final turn's mailbox splice settle before querying
  const state = await handle.query(getAgentState).catch(() => undefined);
  if (!workflowEnded) {
    await handle.signal(cancelAgent).catch(() => undefined);
    await handle.result().catch(() => undefined);
  }
  return { agentId, timedOut, workflowEndedEarly: workflowEnded && classifiedFor() < script.length, state };
}

export async function main(): Promise<void> {
  const baseUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
  const model = process.env.GATEWAY_MODEL ?? "muse-spark-1.3-contributor";
  const apiKey = process.env.GATEWAY_API_KEY;
  const perAgentTimeoutMs = Number(process.env.SWARM_TIMEOUT_MS ?? 300_000);
  const requestTimeoutMs = process.env.GATEWAY_TIMEOUT_MS ? Number(process.env.GATEWAY_TIMEOUT_MS) : undefined;
  // Fault mode: the provider stays down for the whole run, so a healthy
  // agent now ends PARKED (`waiting`) rather than dead. Expect that instead of
  // the normal all-classified outcome.
  const expectParked = process.env.EXPECT_PARKED === "1";
  const expectParkedError = process.env.EXPECT_PARKED_ERROR;

  await preflight(baseUrl, model);

  const records: GatewayTurnRecord[] = [];
  const runner = await startEventRunner({
    taskQueue: `synth-swarm-inference-${Date.now()}`,
    activities: {
      runTurn: createGatewayRunTurn({
        baseUrl,
        model,
        apiKey,
        ...(requestTimeoutMs ? { timeoutMs: requestTimeoutMs } : {}),
        onTurn: (record) => records.push(record),
      }),
    },
  });

  const stamp = Date.now();
  const agents = INFERENCE_SWARM_SCRIPTS.map((entry) => ({
    name: entry.name,
    agentId: `agt_infer_${entry.name}_${stamp}`,
    script: entry.script,
  }));

  const wallStart = Date.now();
  const driven = await Promise.all(
    agents.map((agent) => driveAgent(runner, records, agent.agentId, agent.script, perAgentTimeoutMs)),
  );
  const wallMs = Date.now() - wallStart;

  const perAgent = agents.map((agent) => {
    const turns = records.filter((record) => record.agentId === agent.agentId);
    const score = scoreAgainstScript(agent.script, turns);
    const run = driven.find((entry) => entry.agentId === agent.agentId)!;
    return {
      name: agent.name,
      agentId: agent.agentId,
      finalStatus: run.state?.status ?? "unknown",
      finalMailboxLength: run.state?.mailbox.length ?? null,
      lastError: run.state?.lastError ?? null,
      timedOut: run.timedOut,
      workflowEndedEarly: run.workflowEndedEarly,
      turns: turns.length,
      batchSizes: turns.map((turn) => turn.classifications.length),
      ...score,
    };
  });

  const ids = agents.map((agent) => agent.agentId);
  const traceViolations = swarmIsolationViolations(runner.trace, ids);
  const logViolations = logCorrelationViolations(runner.logs, ids);
  const errorSpans = runner.trace.filter((event) => event.phase === "error");
  const latencies = records.map((record) => record.latencyMs).sort((a, b) => a - b);
  const totalEvents = perAgent.reduce((sum, agent) => sum + agent.expected, 0);
  const totalCorrect = perAgent.reduce((sum, agent) => sum + agent.correct, 0);
  const accuracy = totalEvents === 0 ? 0 : totalCorrect / totalEvents;

  const parkedOk = perAgent.every(
    (agent) =>
      agent.finalStatus === "waiting" &&
      agent.timedOut &&
      typeof agent.lastError === "string" &&
      agent.lastError.length > 0 &&
      (!expectParkedError || agent.lastError.includes(expectParkedError)),
  );
  const agentsHealthy = expectParked
    ? parkedOk
    : perAgent.every(
        (agent) =>
          agent.orderOk &&
          !agent.timedOut &&
          !agent.workflowEndedEarly &&
          agent.lastError === null &&
          agent.finalMailboxLength === 0,
      );
  const isolationOk = traceViolations.length === 0 && logViolations.length === 0;
  const parkedLogs = runner.logs.filter((entry) => entry.message === "synth.workflow.parked").length;
  const ok = expectParked
    ? agentsHealthy && isolationOk && parkedLogs > 0
    : agentsHealthy && isolationOk && accuracy >= ACCURACY_GATE;

  console.log(
    JSON.stringify(
      {
        gateway: baseUrl,
        model,
        wallMs,
        modelCalls: records.length,
        retriedTurns: records.filter((record) => record.attempt > 1).length,
        errorSpans: errorSpans.length,
        latencyMs: { p50: percentile(latencies, 50), max: latencies[latencies.length - 1] ?? 0 },
        tokens: records.reduce((sum, record) => sum + (record.usage?.total_tokens ?? 0), 0),
        accuracy: Number(accuracy.toFixed(3)),
        accuracyGate: ACCURACY_GATE,
        expectParked,
        parkedLogs,
        agents: perAgent,
        isolationOk,
        traceViolations,
        logViolations,
        agentsHealthy,
        ok,
      },
      null,
      2,
    ),
  );
  await runner.close();
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
