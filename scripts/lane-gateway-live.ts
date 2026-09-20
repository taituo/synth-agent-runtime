/**
 * LIVE proof that priority lanes reach a real request.
 *
 * Starts the real gateway (real HTTP server) in front of a deliberately slow
 * backend, tags concurrent requests to different lanes via their bearer token,
 * and asserts the ADMITTED ORDER observable from the responses:
 *   - a batch request holds the single slot;
 *   - a later interactive request overtakes an earlier queued batch request;
 *   - a request past its lane deadline is rejected 429 with a Retry-After.
 *
 * Run: integrations/temporal/node_modules/.bin/tsx scripts/lane-gateway-live.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  CompositeTenantPolicy,
  createInferenceGateway,
  InMemoryTenantRateLimitPolicy,
  LaneScheduler,
  ModelAclPolicy,
  PriorityLanePolicy,
  StaticBearerAuthenticator,
  type GatewayBackend,
  type GatewayPrincipal,
} from "../src/index.js";

const TOKENS: Record<string, GatewayPrincipal> = {
  "tok-interactive": { tenantId: "t-int", subject: "interactive", lane: "interactive" },
  "tok-batch": { tenantId: "t-batch", subject: "batch", lane: "batch" },
  "tok-deadline": { tenantId: "t-dead", subject: "deadline", lane: "deadline" },
};

const backend: GatewayBackend = {
  async listModels() {
    return [{ id: "lane-test-model" }];
  },
  async handle(request: Request) {
    const id = request.headers.get("x-req-id") ?? "?";
    await sleep(600); // hold the single slot long enough for queuing
    return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
  },
};

const scheduler = new LaneScheduler(
  [
    { id: "interactive", priority: 10, weight: 1, maxWaitMs: 5_000 },
    { id: "batch", priority: 1, weight: 1, maxWaitMs: 30_000 },
    { id: "deadline", priority: 1, weight: 1, maxWaitMs: 150 },
  ],
  { capacity: 1, estimatedServiceMs: 600 },
);
const policy = new PriorityLanePolicy(scheduler, { defaultLane: "batch" });
// The spec mandates composing the lane policy with ACL and rate-limit policies
// via CompositeTenantPolicy. Pass the COMPOSITE (not the lane policy directly),
// so the release-forwarding the server relies on is actually exercised.
const tenantPolicy = new CompositeTenantPolicy([new ModelAclPolicy(), policy, new InMemoryTenantRateLimitPolicy()]);

const gateway = createInferenceGateway({
  backend,
  port: 0,
  authenticator: new StaticBearerAuthenticator(TOKENS),
  tenantPolicy,
});
await gateway.listen();

interface Result {
  id: string;
  lane: string;
  status: number;
  retryAfter: string | null;
  atMs: number;
}
const startedAt = Date.now();
const completed: Result[] = [];

async function fire(id: string, token: string, lane: string): Promise<void> {
  const response = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-req-id": id },
    body: JSON.stringify({ model: "lane-test-model", messages: [{ role: "user", content: "hi" }] }),
  });
  await response.text();
  completed.push({ id, lane, status: response.status, retryAfter: response.headers.get("retry-after"), atMs: Date.now() - startedAt });
}

// A (batch) takes the slot; B (batch) and C (interactive) queue behind it;
// D (deadline, 150ms) queues and must be rejected while A still runs.
const a = fire("A", "tok-batch", "batch");
await sleep(60);
const b = fire("B", "tok-batch", "batch");
await sleep(30);
const c = fire("C", "tok-interactive", "interactive");
await sleep(30);
const d = fire("D", "tok-deadline", "deadline");
await Promise.all([a, b, c, d]);

const order = completed.map((entry) => entry.id);
const aResult = completed.find((entry) => entry.id === "A")!;
const bResult = completed.find((entry) => entry.id === "B")!;
const cResult = completed.find((entry) => entry.id === "C")!;
const dResult = completed.find((entry) => entry.id === "D")!;

const interactiveOvertookBatch = cResult.atMs < bResult.atMs;
const deadlineRejected = dResult.status === 429 && dResult.retryAfter !== null;
// No slot leak: after every request finished, the lane scheduler is empty.
const slotsFreed = scheduler.inFlight() === 0 && policy.pending().length === 0;
const ok =
  aResult.status === 200 &&
  bResult.status === 200 &&
  cResult.status === 200 &&
  interactiveOvertookBatch &&
  deadlineRejected &&
  slotsFreed;

console.log(
  JSON.stringify(
    {
      gateway: gateway.url,
      completionOrder: order,
      results: completed,
      interactiveOvertookBatch,
      deadlineRejected,
      slotsFreed,
      inFlightAfter: scheduler.inFlight(),
      ok,
    },
    null,
    2,
  ),
);
await gateway.close();
process.exit(ok ? 0 : 1);
