/**
 * Fault matrix cell: remove the model gateway / provider.
 *
 * A scripted OpenAI-compatible provider (zero quota, no network) is the
 * control. Faults are real HTTP conditions in front of it:
 *
 *   refused    the turn points at a closed port (connection refused)
 *   http-502   a real 502 from `flaky-gateway` on the first completion
 *   hang       the request is accepted and never answered; the turn's timeout
 *              is the only thing that saves it, then it retries
 *   http-429   a 429 with `Retry-After: 1`, then success
 *   http-400   a non-retryable 4xx: the turn must NOT retry
 *
 * The four questions, measured from call counts and the error's `attempts`:
 *   retried      -> `attempts` on the thrown error / returned turn
 *   data lost    -> n/a at the turn level (a model call has no durable state)
 *   human needed -> non-retryable 4xx fails the attempt; transient faults are
 *                   absorbed. The workflow-level park is proven separately by
 *                   `retry-hint-live.ts` / `quota-exhausted-live.ts`.
 *   twice        -> the scripted provider counts HTTP calls made to it; a retry
 *                   is a second model call for the same logical turn.
 *
 * Exit 0 when every scenario matched; 1 otherwise.
 *
 *   npx tsx fault-gateway.ts
 */
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { AddressInfo } from "node:net";
import { createGatewayGymTurn, DEFAULT_GATEWAY_RETRY, type GymTurnInput } from "../../src/index.js";
import { startFlakyGateway } from "./flaky-gateway.js";

interface ProviderControl {
  servedCalls: number;
  status: number;
  delayMs: number;
}

/** A real HTTP server that speaks just enough OpenAI to satisfy the turn. */
function startScriptedProvider(control: ProviderControl): { port: Promise<number>; close: () => Promise<void> } {
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    for await (const _chunk of req) {
      // drain the request body
    }
    control.servedCalls += 1;
    if (control.delayMs > 0) await sleep(control.delayMs);
    if (control.status >= 400) {
      res.writeHead(control.status, { "content-type": "text/plain" }).end(`scripted ${control.status}`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: "scripted-provider",
      choices: [{ message: { role: "assistant", content: JSON.stringify({ tool_calls: [{ name: "finish" }] }) } }],
    }));
  });
  const port = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  return { port, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

const input: GymTurnInput = {
  turnIndex: 0,
  repoDir: "/tmp",
  visibleTestPath: "/tmp/visible.mjs",
  systemPrompt: "You are a test agent. Reply with a tool call.",
  userPrompt: "finish the task",
  transcript: [],
  tools: [],
};

const retry = { ...DEFAULT_GATEWAY_RETRY };

interface ScenarioResult {
  scenario: string;
  attempts?: number;
  error?: string;
  statusCode?: number;
  providerCalls: number;
  outcome: "passed" | "errored";
  expected: string;
  matched: boolean;
}

const results: ScenarioResult[] = [];

async function runTurn(baseUrl: string, timeoutMs?: number): Promise<{ attempts?: number; error?: string; statusCode?: number }> {
  const turn = createGatewayGymTurn({ baseUrl, model: "scripted-model", timeoutMs, retry });
  try {
    const result = await turn(input);
    return { attempts: result.attempts };
  } catch (error) {
    const tagged = error as { message?: string; status?: number; attempts?: number };
    return { error: tagged.message ?? String(error), statusCode: tagged.status, attempts: tagged.attempts };
  }
}

// 1. Connection refused.
{
  const outcome = await runTurn("http://127.0.0.1:59999");
  results.push({
    scenario: "refused",
    ...outcome,
    providerCalls: 0,
    outcome: outcome.error ? "errored" : "passed",
    expected: "3 attempts (network error is retryable), then error",
    matched: outcome.attempts === 3 && Boolean(outcome.error),
  });
}

// 2. HTTP 502 on the first completion, then success.
{
  const control: ProviderControl = { servedCalls: 0, status: 200, delayMs: 0 };
  const provider = startScriptedProvider(control);
  const upstreamPort = await provider.port;
  const port = 59001;
  const proxy = startFlakyGateway({ upstream: `http://127.0.0.1:${upstreamPort}`, port, mode: "502", failFirst: 1 });
  await proxy.listen();
  try {
    const outcome = await runTurn(`http://127.0.0.1:${port}`);
    results.push({
      scenario: "http-502",
      ...outcome,
      providerCalls: control.servedCalls,
      outcome: outcome.error ? "errored" : "passed",
      expected: "turn recovers with attempts=2; provider served exactly 1",
      matched: outcome.attempts === 2 && control.servedCalls === 1,
    });
  } finally {
    await proxy.close();
    await provider.close();
  }
}

// 3. Hang: never answered, the turn's own timeout must save it and retry.
{
  const control: ProviderControl = { servedCalls: 0, status: 200, delayMs: 0 };
  const provider = startScriptedProvider(control);
  const upstreamPort = await provider.port;
  const port = 59002;
  const proxy = startFlakyGateway({ upstream: `http://127.0.0.1:${upstreamPort}`, port, mode: "hang", failFirst: 1 });
  await proxy.listen();
  try {
    const started = Date.now();
    const outcome = await runTurn(`http://127.0.0.1:${port}`, 1_500);
    const wallMs = Date.now() - started;
    results.push({
      scenario: "hang",
      ...outcome,
      providerCalls: control.servedCalls,
      outcome: outcome.error ? "errored" : "passed",
      expected: "turn times out at ~1.5s, retries, succeeds; provider served 1",
      matched: outcome.attempts === 2 && control.servedCalls === 1 && wallMs >= 1_400,
    });
  } finally {
    await proxy.close();
    await provider.close();
  }
}

// 4. 429 with Retry-After on the first two, then success.
{
  const control: ProviderControl = { servedCalls: 0, status: 200, delayMs: 0 };
  const provider = startScriptedProvider(control);
  const upstreamPort = await provider.port;
  const port = 59003;
  const proxy = startFlakyGateway({ upstream: `http://127.0.0.1:${upstreamPort}`, port, mode: "429", failFirst: 2, retryAfterSeconds: 1 });
  await proxy.listen();
  try {
    const outcome = await runTurn(`http://127.0.0.1:${port}`);
    results.push({
      scenario: "http-429",
      ...outcome,
      providerCalls: control.servedCalls,
      outcome: outcome.error ? "errored" : "passed",
      expected: "turn recovers with attempts=3; provider served 1",
      matched: outcome.attempts === 3 && control.servedCalls === 1,
    });
  } finally {
    await proxy.close();
    await provider.close();
  }
}

// 5. Non-retryable 400: exactly one attempt, no retry.
{
  const control: ProviderControl = { servedCalls: 0, status: 400, delayMs: 0 };
  const provider = startScriptedProvider(control);
  const port = await provider.port;
  try {
    const outcome = await runTurn(`http://127.0.0.1:${port}`);
    results.push({
      scenario: "http-400",
      ...outcome,
      providerCalls: control.servedCalls,
      outcome: outcome.error ? "errored" : "passed",
      expected: "exactly 1 attempt and status 400 (not retried)",
      matched: outcome.attempts === 1 && outcome.statusCode === 400 && control.servedCalls === 1,
    });
  } finally {
    await provider.close();
  }
}

const ok = results.every((entry) => entry.matched);
console.log(JSON.stringify({ ok, fault: "gateway", retryConfig: retry, results }, null, 2));
process.exit(ok ? 0 : 1);
