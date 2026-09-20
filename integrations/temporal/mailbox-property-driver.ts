/**
 * Track 3 live proof: property-based mailbox/turn batching against real Temporal.
 *
 * For each seed it generates an event stream (steady/bursty/herd arrival),
 * drives it through a real `durableAgentWorkflow` with a stub activity that
 * takes long enough that events arrive mid-turn, and asserts the property the
 * mailbox fix must guarantee: concat(turns' batches) == the input stream,
 * exactly, in order. The seed is printed; on failure the stream is shrunk to a
 * minimal failing prefix (same seed, smaller size).
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx mailbox-property-driver.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { Context as ActivityContext, log as activityLog } from "@temporalio/activity";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { runTemporalWorker } from "./src/worker.js";
import {
  batchProperty,
  boundedTurns,
  firstConsumptionOrder,
  generateReturnStates,
  generateStream,
  shrinkPrefix,
  type ArrivalPattern,
  type GeneratedEvent,
  type ReturnState,
} from "./mailbox-generator.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `synth-mailbox-prop-${Date.now()}`;
const TURN_MS = Number(process.env.TURN_MS ?? 400);
const SEEDS = (process.env.SEEDS ?? "1,2,3,4,5,6,7,8").split(",").map((value) => Number(value.trim()));
const PATTERNS: ArrivalPattern[] = ["steady", "bursty", "herd"];
const DEFAULT_SIZE = Number(process.env.SIZE ?? 14);

// Batches recorded per agent, in turn order, with the start time of each turn.
const batchesByAgent = new Map<string, string[][]>();
const timesByAgent = new Map<string, number[]>();
// Per-agent sequence of states the activity returns (fuzzed dimension).
// `turnMs` is 0 in fuzz mode so a spin is visible (a per-turn sleep would
// otherwise mask it); the real park backoff is the only delay that should
// separate a deferred turn from the next.
const returnPlans = new Map<string, { states: ReturnState[]; turn: number; turnMs: number }>();
// Short park backoff so fuzzed `waiting` returns finish quickly.
const FAST_PARK = { initialMs: 300, maxMs: 900 };
// A deferred turn must be followed by a backoff; anything under this is a spin.
const MIN_DEFER_GAP_MS = 150;

const activities = {
  async runTurn(input: { agentId: string; messages: Array<{ id: string }> }) {
    const attempt = ActivityContext.current().info.attempt;
    const plan = returnPlans.get(input.agentId);
    const state: ReturnState = plan ? (plan.states[plan.turn] ?? "idle") : "idle";
    if (plan) plan.turn++;
    activityLog.info("synth.activity.runTurn", { attempt, batch: input.messages.length, returnedState: state });
    await sleep(plan?.turnMs ?? TURN_MS);
    const list = batchesByAgent.get(input.agentId) ?? [];
    list.push(input.messages.map((message) => message.id));
    batchesByAgent.set(input.agentId, list);
    const times = timesByAgent.get(input.agentId) ?? [];
    times.push(Date.now());
    timesByAgent.set(input.agentId, times);
    return { result: `ok:${input.messages.length}`, state };
  },
};

void runTemporalWorker({
  workflowsPath: fileURLToPath(new URL("./src/workflows.ts", import.meta.url)),
  workflowInterceptorModules: [fileURLToPath(new URL("./src/workflow-interceptors.ts", import.meta.url))],
  activities,
  taskQueue,
  address,
  namespace,
}).catch((error) => {
  console.error("worker failed", error);
  process.exit(1);
});

await sleep(2500);
const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });

async function runStream(seed: number, size: number, pattern: ArrivalPattern): Promise<{ ok: boolean; reason?: string; input: GeneratedEvent[]; batches: string[][] }> {
  const stream = generateStream(seed, { size, pattern });
  const agentId = `agt_prop_${seed}_${pattern}_${size}_${Date.now()}`;
  batchesByAgent.set(agentId, []);
  const handle = await client.workflow.start(durableAgentWorkflow, {
    taskQueue,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now() }],
  });

  for (const event of stream) {
    if (event.delayMs > 0) await sleep(event.delayMs);
    await handle.signal(sendMessage, { id: event.id, role: "human", text: event.text, createdAt: Date.now(), kind: event.kind });
  }

  const consumed = () => (batchesByAgent.get(agentId) ?? []).flat().length;
  const deadline = Date.now() + Math.max(30_000, size * 400);
  // Stop early when the run has stalled (no new batch for a couple of turns):
  // a real bug that drops events would otherwise sit until the full deadline,
  // making the shrinker unusably slow.
  let lastCount = -1;
  let lastChangeAt = Date.now();
  while (consumed() < stream.length && Date.now() < deadline) {
    const count = consumed();
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt > TURN_MS * 2 + 1500) {
      break;
    }
    await sleep(100);
  }
  await sleep(200);
  await handle.signal(cancelAgent).catch(() => undefined);
  await handle.result().catch(() => undefined);

  const batches = batchesByAgent.get(agentId) ?? [];
  const property = batchProperty(stream.map((event) => event.id), batches);
  return { ...property, input: stream, batches };
}

/**
 * Fuzzed-return-state run: the activity returns a seeded sequence of
 * `idle`/`waiting`. A `waiting` turn defers (does not consume), so the raw
 * concatenation repeats a prefix; the invariants are (a) first-consumption
 * order equals the input, and (b) the run does not spin (bounded turns).
 */
async function runFuzzedStream(seed: number, size: number, pattern: ArrivalPattern) {
  const stream = generateStream(seed, { size, pattern });
  const returnStates = generateReturnStates(seed, size * 2, 4);
  const waitingCount = returnStates.filter((state) => state === "waiting").length;
  const agentId = `agt_fuzz_${seed}_${pattern}_${size}_${Date.now()}`;
  batchesByAgent.set(agentId, []);
  timesByAgent.set(agentId, []);
  returnPlans.set(agentId, { states: returnStates, turn: 0, turnMs: 0 });
  const handle = await client.workflow.start(durableAgentWorkflow, {
    taskQueue,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now(), parkBackoff: FAST_PARK }],
  });
  for (const event of stream) {
    if (event.delayMs > 0) await sleep(event.delayMs);
    await handle.signal(sendMessage, { id: event.id, role: "human", text: event.text, createdAt: Date.now(), kind: event.kind });
  }

  const distinct = () => firstConsumptionOrder(batchesByAgent.get(agentId) ?? []).length;
  const deadline = Date.now() + Math.max(40_000, size * 800);
  while (distinct() < stream.length && Date.now() < deadline) await sleep(100);
  await sleep(200);
  const state = await handle.query(getAgentState).catch(() => undefined);
  await handle.signal(cancelAgent).catch(() => undefined);
  await handle.result().catch(() => undefined);

  const batches = batchesByAgent.get(agentId) ?? [];
  const times = timesByAgent.get(agentId) ?? [];
  const expectedIds = stream.map((event) => event.id);
  const order = firstConsumptionOrder(batches);
  const orderOk = order.length === expectedIds.length && order.every((id, index) => id === expectedIds[index]);
  const turnsOk = boundedTurns(batches, stream.length, waitingCount);
  const drainedOk = state?.mailbox.length === 0 && state?.status === "idle";
  // Every deferred turn must be separated from the next by a backoff, not
  // re-run immediately (the waiting-spin bug).
  let minDeferGapMs = Number.POSITIVE_INFINITY;
  let deferGapsOk = true;
  for (let i = 0; i < batches.length - 1; i++) {
    if (returnStates[i] === "waiting") {
      const gap = times[i + 1]! - times[i]!;
      minDeferGapMs = Math.min(minDeferGapMs, gap);
      if (gap < MIN_DEFER_GAP_MS) deferGapsOk = false;
    }
  }
  if (!Number.isFinite(minDeferGapMs)) minDeferGapMs = 0;
  return {
    seed,
    pattern,
    size,
    returnStates: returnStates.slice(0, batches.length),
    turns: batches.length,
    waitingTurns: batches.length === 0 ? 0 : returnStates.slice(0, batches.length).filter((s) => s === "waiting").length,
    minDeferGapMs,
    orderOk,
    turnsOk,
    deferGapsOk,
    drainedOk,
    ok: orderOk && turnsOk && drainedOk && deferGapsOk,
  };
}

interface SeedResult {
  seed: number;
  pattern: ArrivalPattern;
  size: number;
  ok: boolean;
  batches: number[];
  shrunkTo?: number;
  reason?: string;
}
const results: SeedResult[] = [];
let allOk = true;

for (const pattern of PATTERNS) {
  for (const seed of SEEDS) {
    const run = await runStream(seed, DEFAULT_SIZE, pattern);
    const entry: SeedResult = { seed, pattern, size: DEFAULT_SIZE, ok: run.ok, batches: run.batches.map((b) => b.length) };
    if (!run.ok) {
      allOk = false;
      // Shrink: same seed, smaller sizes; the first failing size is minimal.
      const minimal = await shrinkPrefix(run.input, async (candidate) => {
        const shrunk = await runStream(seed, candidate.length, pattern);
        return !shrunk.ok;
      });
      entry.shrunkTo = minimal.length;
      entry.reason = run.reason;
    }
    results.push(entry);
    console.log(JSON.stringify(entry));
  }
}

// Fuzzed-return-state dimension (the class the waiting-spin bug lived in).
const FUZZ_SEEDS = (process.env.FUZZ_SEEDS ?? "1,2,3").split(",").map((value) => Number(value.trim()));
const fuzzResults = [];
for (const pattern of PATTERNS) {
  for (const seed of FUZZ_SEEDS) {
    const entry = await runFuzzedStream(seed, DEFAULT_SIZE, pattern);
    fuzzResults.push(entry);
    if (!entry.ok) allOk = false;
    console.log(JSON.stringify({ fuzz: entry }));
  }
}

console.log(
  JSON.stringify({ seeds: SEEDS, patterns: PATTERNS, size: DEFAULT_SIZE, turnMs: TURN_MS, fuzzSeeds: FUZZ_SEEDS, allOk, results, fuzzResults }, null, 2),
);
await connection.close();
process.exit(allOk ? 0 : 1);
