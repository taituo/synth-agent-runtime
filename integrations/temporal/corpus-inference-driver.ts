/**
 * Track 2 live proof: the MESSY corpus through real inference.
 *
 * Feeds `test/fixtures/corpora/messy-events.ts` (real CVE/Wikipedia/release
 * texts plus synthetic social/ambiguous/hostile items) through one durable
 * agent and the real gateway, then checks:
 *   - structural integrity on EVERY item: nothing lost, duplicated or reordered;
 *   - hostile items (prompt injection, embedded reply-format JSON, whitespace)
 *     never changed the reply's shape;
 *   - accuracy over the scorable items against the measured gate.
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 GATEWAY_URL=http://127.0.0.1:8787 \
 *   npx tsx corpus-inference-driver.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { createGatewayRunTurn, type GatewayTurnRecord } from "./src/gateway-run-turn.js";
import { startEventRunner } from "./event-runner.js";
import { MESSY_EVENTS } from "../../test/fixtures/corpora/messy-events.js";
import { CORPUS_ACCURACY_GATE, CORPUS_BASELINE, corpusScript, scoreCorpus } from "../../test/fixtures/messy-corpus.js";

const baseUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
const model = process.env.GATEWAY_MODEL ?? "muse-spark-1.3-contributor";
const timeoutMs = Number(process.env.SWARM_TIMEOUT_MS ?? 180_000);

async function preflight(): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`gateway ${baseUrl} /v1/models returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id: string }> };
  if (!(body.data ?? []).some((entry) => entry.id === model)) throw new Error(`gateway does not list model ${model}`);
}

export async function main(): Promise<void> {
  await preflight();
  const records: GatewayTurnRecord[] = [];
  const runner = await startEventRunner({
    taskQueue: `synth-corpus-inference-${Date.now()}`,
    activities: {
      runTurn: createGatewayRunTurn({
        baseUrl,
        model,
        ...(process.env.GATEWAY_API_KEY ? { apiKey: process.env.GATEWAY_API_KEY } : {}),
        onTurn: (record) => records.push(record),
      }),
    },
  });

  const agentId = `agt_corpus_${Date.now()}`;
  const handle = await runner.client.workflow.start(durableAgentWorkflow, {
    taskQueue: runner.taskQueue,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now() }],
  });

  for (const event of corpusScript()) {
    if (event.delayMs > 0) await sleep(event.delayMs);
    await handle.signal(sendMessage, {
      id: `${agentId}-${event.kind}-${Math.random().toString(36).slice(2)}`,
      role: "human",
      text: event.text,
      createdAt: Date.now(),
      kind: event.kind,
    });
  }

  const classified = () =>
    records.filter((record) => record.agentId === agentId).reduce((sum, record) => sum + record.classifications.length, 0);
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  while (classified() < MESSY_EVENTS.length) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    await sleep(250);
  }
  await sleep(300);
  const state = await handle.query(getAgentState).catch(() => undefined);
  await handle.signal(cancelAgent).catch(() => undefined);
  await handle.result().catch(() => undefined);

  const turns = records.filter((record) => record.agentId === agentId);
  const score = scoreCorpus(MESSY_EVENTS, turns);
  const ok =
    !timedOut &&
    state?.status === "idle" &&
    (state?.lastError ?? null) === null &&
    score.orderOk &&
    score.structuralOk &&
    score.injectionShapeOk &&
    score.accuracy >= CORPUS_ACCURACY_GATE;

  console.log(
    JSON.stringify(
      {
        gateway: baseUrl,
        model,
        corpus: { total: MESSY_EVENTS.length, scorable: score.scorable, real: MESSY_EVENTS.filter((i) => i.provenance === "real").length },
        timedOut,
        finalStatus: state?.status ?? "unknown",
        lastError: state?.lastError ?? null,
        modelCalls: turns.length,
        batchSizes: turns.map((turn) => turn.classifications.length),
        retriedTurns: turns.filter((turn) => turn.attempt > 1).length,
        accuracy: Number(score.accuracy.toFixed(3)),
        gate: CORPUS_ACCURACY_GATE,
        baseline: CORPUS_BASELINE,
        correct: score.correct,
        orderOk: score.orderOk,
        structuralOk: score.structuralOk,
        injectionShapeOk: score.injectionShapeOk,
        mismatches: score.mismatches.map((m) => ({ id: m.id, planted: m.planted, got: m.got })),
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
