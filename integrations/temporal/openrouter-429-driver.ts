/**
 * Item 3 live proof: real 429s from OpenRouter's free tier, no fault injection.
 *
 * Drives a durable agent past OpenRouter's free-tier limit (20 req/min) with a
 * `:free` model, then checks that the agent parks, that the park tracks the
 * real `Retry-After`/reset header OpenRouter returns, that no agent dies, and
 * that every event is eventually classified without loss or reorder. Observed
 * response headers are printed verbatim so we learn their exact spelling.
 *
 * Needs OPENROUTER_API_KEY. Absent => SKIP as a distinct outcome (exit 2, never
 * `ok:true`), the same rule as `fault-rungs.ts`.
 *
 *   OPENROUTER_API_KEY=... npx tsx openrouter-429-driver.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./src/workflows.js";
import { createGatewayRunTurn, type GatewayTurnRecord } from "./src/gateway-run-turn.js";
import { parseRetryHintMs } from "./src/retry-hints.js";
import { honoursRetryHint } from "./src/park-tracking.js";
import { startEventRunner } from "./event-runner.js";
import { INFERENCE_SWARM_SCRIPTS, logCorrelationViolations, scoreAgainstScript, swarmIsolationViolations } from "./event-script.js";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error(JSON.stringify({ skipped: true, reason: "OPENROUTER_API_KEY not set; real 429 proof requires it" }));
  process.exit(2);
}

const baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api";
const model = process.env.OPENROUTER_MODEL ?? "meta-llama/llama-3.3-70b-instruct:free";
const requestTimeoutMs = Number(process.env.GATEWAY_TIMEOUT_MS ?? 120_000);
// One script's worth of events, spaced so each becomes its own turn: >20 calls
// within a minute trips the free-tier limit.
const script = INFERENCE_SWARM_SCRIPTS[0]!.script;

interface ObservedResponse {
  status: number;
  headers: Record<string, string>;
  at: number;
}
const observed: ObservedResponse[] = [];
const capturingFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    observed.push({ status: response.status, headers, at: Date.now() });
  }
  return response;
};

export async function main(): Promise<void> {
  const records: GatewayTurnRecord[] = [];
  const runner = await startEventRunner({
    taskQueue: `synth-openrouter-${Date.now()}`,
    activities: {
      runTurn: createGatewayRunTurn({
        baseUrl,
        model,
        apiKey,
        timeoutMs: requestTimeoutMs,
        fetchImpl: capturingFetch,
        onTurn: (record) => records.push(record),
      }),
    },
  });

  const agentId = `agt_openrouter_${Date.now()}`;
  const handle = await runner.client.workflow.start(durableAgentWorkflow, {
    taskQueue: runner.taskQueue,
    workflowId: `agent/${agentId}`,
    args: [{ agentId, status: "idle", mailbox: [], updatedAt: Date.now(), parkBackoff: { initialMs: 5_000, maxMs: 60_000 } }],
  });
  const callTimes: number[] = [];
  for (let i = 0; i < script.length; i++) {
    const event = script[i]!;
    if (i > 0) await sleep(1_200); // slower than one turn => one call per event
    callTimes.push(Date.now());
    await handle.signal(sendMessage, { id: `${agentId}-${event.kind}-${i}`, role: "human", text: event.text, createdAt: Date.now(), kind: event.kind });
  }

  const classified = () => records.filter((record) => record.agentId === agentId).reduce((sum, record) => sum + record.classifications.length, 0);
  let parked = false;
  let state = await handle.query(getAgentState).catch(() => undefined);
  // Measure how long the workflow actually spent parked, so the assertion is
  // about TIMING (does the wait track the server's hint?) and not just status.
  let waitingSince: number | undefined;
  let longestWaitMs = 0;
  const observeWaiting = (): void => {
    if (state?.status === "waiting") {
      parked = true;
      if (waitingSince === undefined) waitingSince = Date.now();
    } else if (waitingSince !== undefined) {
      longestWaitMs = Math.max(longestWaitMs, Date.now() - waitingSince);
      waitingSince = undefined;
    }
  };
  observeWaiting();
  const deadline = Date.now() + 20 * 60_000;
  while (classified() < script.length && Date.now() < deadline) {
    state = await handle.query(getAgentState).catch(() => undefined);
    observeWaiting();
    await sleep(250);
  }
  if (waitingSince !== undefined) longestWaitMs = Math.max(longestWaitMs, Date.now() - waitingSince);
  await sleep(300);
  state = await handle.query(getAgentState).catch(() => undefined);
  await handle.signal(cancelAgent).catch(() => undefined);
  await handle.result().catch(() => undefined);

  const turns = records.filter((record) => record.agentId === agentId);
  const score = scoreAgainstScript(script, turns);
  const rateLimited = observed.filter((entry) => entry.status === 429);
  // The park after the failures must track the server's own hint, not a blind
  // backoff. `parked` alone would pass on a fixed-backoff implementation, so
  // the assertion is that the observed wait is at least the parsed hint.
  const lastHint = rateLimited.length > 0 ? parseRetryHintMs(new Headers(rateLimited[rateLimited.length - 1]!.headers)) : undefined;
  const parkToleranceMs = Number(process.env.PARK_TOLERANCE_MS ?? 1_500);
  const expectedParkMs = lastHint !== undefined && lastHint > 0 ? lastHint : undefined;
  const honoursHint = honoursRetryHint({ longestWaitMs, hintMs: lastHint, toleranceMs: parkToleranceMs });
  const ids = [agentId];
  const isolationOk = swarmIsolationViolations(runner.trace, ids).length === 0 && logCorrelationViolations(runner.logs, ids).length === 0;
  const ok =
    rateLimited.length > 0 &&
    parked &&
    honoursHint &&
    state?.status === "idle" &&
    (state?.lastError ?? null) === null &&
    score.orderOk &&
    score.classified === script.length &&
    isolationOk;

  console.log(
    JSON.stringify(
      {
        gateway: baseUrl,
        model,
        observed429s: rateLimited.length,
        observedHeadersVerbatim: observed.map((entry) => ({ status: entry.status, headers: entry.headers })),
        parsedLastHintMs: lastHint ?? null,
        parked,
        longestWaitMs,
        expectedParkMs: expectedParkMs ?? null,
        parkToleranceMs,
        honoursHint,
        finalStatus: state?.status ?? "unknown",
        lastError: state?.lastError ?? null,
        classified: score.classified,
        expected: script.length,
        orderOk: score.orderOk,
        isolationOk,
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
    process.exit(1);
  });
}
