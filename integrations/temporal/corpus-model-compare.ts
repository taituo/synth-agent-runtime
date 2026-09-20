/**
 * Run the corpus measurement across an explicit list of models and compare.
 *
 * Model visibility gap 3: a single measurement is one model's number, so a
 * comparison needs the model named per row, the served-model check, and the
 * cost stated up front. Never defaults to "all models" — MODELS is required,
 * and the projected call count is printed before any call is made.
 *
 *   MODELS=deepseek-v4-flash,qwen3.7-plus,deepseek-v4-pro \
 *   GATEWAY_URL=http://127.0.0.1:8791 TEMPORAL_ADDRESS=127.0.0.1:7243 \
 *   npx tsx corpus-model-compare.ts
 *
 * Exit: 0 all models ran and stayed in order; 1 a model failed or the actual
 * call count exceeded the projection by more than 20%; 2 skipped (no gateway,
 * no models, or the model list is "all").
 */
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { createGatewayRunTurn, type GatewayTurnRecord } from "./src/gateway-run-turn.js";
import { startEventRunner } from "./event-runner.js";
import { MESSY_EVENTS } from "../../test/fixtures/corpora/messy-events.js";
import { corpusScript, scoreCorpus } from "../../test/fixtures/messy-corpus.js";

const baseUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
const timeoutMs = Number(process.env.COMPARE_TIMEOUT_MS ?? 180_000);
const models = (process.env.MODELS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

if (models.length === 0) {
  console.error(JSON.stringify({ skipped: true, reason: "Set MODELS to an explicit comma-separated list; there is no all-models default" }));
  process.exit(2);
}
if (models.some((model) => model === "all" || model === "*")) {
  console.error(JSON.stringify({ skipped: true, reason: "Refusing 'all'/'*': running every model multiplies quota. Name the models." }));
  process.exit(2);
}

// Upper bound: one call per event per model. Batching only lowers the actual.
const projectedCalls = models.length * MESSY_EVENTS.length;
console.log(JSON.stringify({ projectedCalls, models, eventsPerModel: MESSY_EVENTS.length, gateway: baseUrl }));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function listModels(): Promise<string[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`gateway /v1/models returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((entry) => entry.id);
}

interface ModelResult {
  model: string;
  ok: boolean;
  reason?: string;
  accuracy?: number;
  correct?: number;
  scorable?: number;
  orderOk?: boolean;
  structuralOk?: boolean;
  injectionShapeOk?: boolean;
  modelCalls: number;
  retriedTurns: number;
  tokens: number;
  latencyMs: { p50: number; max: number };
  wallMs: number;
  servedModels: string[];
  substitutions: number;
  unknownServed: number;
  finalStatus: string;
}

async function runModel(model: string): Promise<ModelResult> {
  const records: GatewayTurnRecord[] = [];
  const startedAt = Date.now();
  const agentId = `agt_cmp_${model.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`;
  let runner: Awaited<ReturnType<typeof startEventRunner>> | undefined;
  try {
    runner = await startEventRunner({
      taskQueue: `synth-compare-${model.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}`,
      activities: {
        runTurn: createGatewayRunTurn({
          baseUrl,
          model,
          ...(process.env.GATEWAY_API_KEY ? { apiKey: process.env.GATEWAY_API_KEY } : {}),
          onTurn: (record) => records.push(record),
        }),
      },
    });
    const handle = await runner.client.workflow.start(durableAgentWorkflow, {
      taskQueue: runner.taskQueue,
      workflowId: `agent/${agentId}`,
      args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now() }],
    });
    for (const event of corpusScript()) {
      if (event.delayMs > 0) await sleep(event.delayMs);
      await handle.signal(sendMessage, { id: `${agentId}-${event.kind}-${Math.random().toString(36).slice(2)}`, role: "human", text: event.text, createdAt: Date.now(), kind: event.kind });
    }
    const classified = () => records.filter((record) => record.agentId === agentId).reduce((sum, record) => sum + record.classifications.length, 0);
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    while (classified() < MESSY_EVENTS.length) {
      if (Date.now() > deadline) { timedOut = true; break; }
      await sleep(250);
    }
    await sleep(300);
    const state = await handle.query(getAgentState).catch(() => undefined);
    await handle.signal(cancelAgent).catch(() => undefined);
    await handle.result().catch(() => undefined);

    const turns = records.filter((record) => record.agentId === agentId);
    const score = scoreCorpus(MESSY_EVENTS, turns);
    const latencies = turns.map((turn) => turn.latencyMs).sort((a, b) => a - b);
    const servedModels = [...new Set(turns.map((turn) => turn.servedModel ?? "unknown"))].sort();
    const ok = !timedOut && score.orderOk && score.classified === MESSY_EVENTS.length && (state?.lastError ?? null) === null;
    return {
      model,
      ok,
      ...(timedOut ? { reason: "timed out" } : {}),
      accuracy: Number(score.accuracy.toFixed(3)),
      correct: score.correct,
      scorable: score.scorable,
      orderOk: score.orderOk,
      structuralOk: score.structuralOk,
      injectionShapeOk: score.injectionShapeOk,
      modelCalls: turns.length,
      retriedTurns: turns.filter((turn) => turn.attempt > 1).length,
      tokens: turns.reduce((sum, turn) => sum + (turn.usage?.total_tokens ?? 0), 0),
      latencyMs: { p50: percentile(latencies, 50), max: latencies[latencies.length - 1] ?? 0 },
      wallMs: Date.now() - startedAt,
      servedModels,
      substitutions: turns.filter((turn) => turn.modelSubstituted).length,
      unknownServed: turns.filter((turn) => turn.servedModel === null).length,
      finalStatus: state?.status ?? "unknown",
    };
  } catch (error) {
    return {
      model,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      modelCalls: records.length,
      retriedTurns: records.filter((record) => record.attempt > 1).length,
      tokens: 0,
      latencyMs: { p50: 0, max: 0 },
      wallMs: Date.now() - startedAt,
      servedModels: [],
      substitutions: 0,
      unknownServed: 0,
      finalStatus: "unknown",
    };
  } finally {
    await runner?.close();
  }
}

export async function main(): Promise<void> {
  let available: string[];
  try {
    available = await listModels();
  } catch (error) {
    console.error(JSON.stringify({ skipped: true, reason: `gateway ${baseUrl} is not reachable: ${error instanceof Error ? error.message : String(error)}` }));
    process.exit(2);
  }
  const missing = models.filter((model) => !available.includes(model));
  if (missing.length > 0) {
    console.error(JSON.stringify({ skipped: true, reason: `gateway does not list: ${missing.join(", ")}` }));
    process.exit(2);
  }

  const results: ModelResult[] = [];
  for (const model of models) results.push(await runModel(model));

  const actualCalls = results.reduce((sum, result) => sum + result.modelCalls, 0);
  const overBudget = actualCalls > projectedCalls * 1.2;
  const ok = !overBudget && results.every((result) => result.ok);
  console.log(
    JSON.stringify(
      {
        projectedCalls,
        actualCalls,
        overBudget,
        models: models.length,
        table: results.map((result) => ({
          model: result.model,
          accuracy: result.accuracy,
          correct: result.correct,
          scorable: result.scorable,
          latencyP50Ms: result.latencyMs.p50,
          latencyMaxMs: result.latencyMs.max,
          tokens: result.tokens,
          modelCalls: result.modelCalls,
          retriedTurns: result.retriedTurns,
          wallMs: result.wallMs,
          failures: (result.scorable ?? 0) - (result.correct ?? 0),
          orderOk: result.orderOk,
          structuralOk: result.structuralOk,
          injectionShapeOk: result.injectionShapeOk,
          requestedModel: result.model,
          servedModels: result.servedModels,
          substitutions: result.substitutions,
          unknownServed: result.unknownServed,
          finalStatus: result.finalStatus,
          ok: result.ok,
          ...(result.reason ? { reason: result.reason } : {}),
        })),
        ok,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
