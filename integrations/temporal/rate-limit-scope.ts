/**
 * Measure whether the rate limit is per-model or shared across the account.
 *
 * With one subscription account, per-account and per-provider are the same
 * thing, so the answerable question is: does exhausting one model throttle a
 * DIFFERENT model on the same account? Fire a burst at model A, then probe
 * model B immediately:
 *   - A throttles, B succeeds  -> the limit is per-model (spreading helps);
 *   - A throttles, B throttles -> the limit is shared (adaptive concurrency is
 *     the lever, model spreading is not).
 *
 * Cost discipline: MODELS is required, the projected call count is printed
 * before any call, and the run aborts if actual calls exceed it by more than
 * 20%. Exit 2 on skip (no gateway/models), 0 on a conclusive result, 1 if the
 * burst never throttled (inconclusive: raise BURST).
 *
 *   MODELS=deepseek-v4-flash,qwen3.8-flash BURST=25 \
 *   GATEWAY_URL=http://127.0.0.1:8791 npx tsx rate-limit-scope.ts
 */
import { pathToFileURL } from "node:url";

const baseUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
const models = (process.env.MODELS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
const burst = Number(process.env.BURST ?? 25);

if (models.length < 2) {
  console.error(JSON.stringify({ skipped: true, reason: "Set MODELS to at least two models; scope needs a second model to probe" }));
  process.exit(2);
}
const projectedCalls = burst + (models.length - 1) * 2;
console.log(JSON.stringify({ projectedCalls, burst, probeModels: models.slice(1), gateway: baseUrl }));

type ThrottleKind = "none" | "rate-limit" | "error";

interface Attempt {
  model: string;
  status: number;
  kind: ThrottleKind;
  retryAfter: string | null;
  body: string;
  rateLimitHeaders: Record<string, string>;
}

const RATE_LIMIT_HEADERS = new Set([
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-rate-limit-limit",
  "x-rate-limit-remaining",
  "x-rate-limit-reset",
]);

function throttleKind(status: number, body: string): ThrottleKind {
  if (status === 429 || status === 402) return "rate-limit";
  // A 5xx (or a fetch failure) is a transient provider error, not proof of a
  // rate limit; the gateway surfaces a masked upstream 429 as 5xx, so the body
  // is checked too.
  if (status >= 500 || status === 0) return /(^|[^0-9])(429|rate.?limit|quota|too many requests)/i.test(body) ? "rate-limit" : "error";
  return "none";
}

async function call(model: string): Promise<Attempt> {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 4 }),
    });
    const body = (await response.text()).slice(0, 300);
    const rateLimitHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { if (RATE_LIMIT_HEADERS.has(key.toLowerCase())) rateLimitHeaders[key.toLowerCase()] = value; });
    return { model, status: response.status, kind: throttleKind(response.status, body), retryAfter: response.headers.get("retry-after"), body, rateLimitHeaders };
  } catch (error) {
    return { model, status: 0, kind: "error" as const, retryAfter: null, body: `${error instanceof Error ? error.message : String(error)} (${Date.now() - started}ms)`, rateLimitHeaders: {} };
  }
}

async function main(): Promise<void> {
  const health = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(8000) }).catch(() => undefined);
  if (!health?.ok) {
    console.error(JSON.stringify({ skipped: true, reason: `gateway ${baseUrl} is not reachable` }));
    process.exit(2);
  }

  // Phase A: burst model A concurrently.
  const primary = models[0]!;
  const burstStart = Date.now();
  const burstAttempts = await Promise.all(Array.from({ length: burst }, () => call(primary)));
  const burstWallMs = Date.now() - burstStart;
  const burstRateLimited = burstAttempts.filter((attempt) => attempt.kind === "rate-limit").length;
  const burstErrors = burstAttempts.filter((attempt) => attempt.kind === "error").length;
  const firstThrottle = burstAttempts.findIndex((attempt) => attempt.kind !== "none");

  // Phase B: immediately probe each other model once, then once more after 2s.
  const probes: Attempt[] = [];
  for (const model of models.slice(1)) probes.push(await call(model));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  for (const model of models.slice(1)) probes.push(await call(model));

  const actualCalls = burstAttempts.length + probes.length;
  const overBudget = actualCalls > projectedCalls * 1.2;
  const probeRateLimited = probes.filter((attempt) => attempt.kind === "rate-limit").length;
  const conclusive = burstRateLimited > 0 && !overBudget;
  const scope = !conclusive
    ? burstErrors > 0
      ? "transient-errors-only"
      : "inconclusive"
    : probeRateLimited > 0
      ? "shared-account"
      : "per-model";

  console.log(
    JSON.stringify(
      {
        scope,
        conclusive,
        burstModel: primary,
        burst,
        burstRateLimited,
        burstErrors,
        firstThrottleIndex: firstThrottle,
        burstStatuses: burstAttempts.map((attempt) => attempt.status),
        burstStatusCounts: burstAttempts.reduce<Record<string, number>>((acc, attempt) => {
          acc[attempt.status] = (acc[attempt.status] ?? 0) + 1;
          return acc;
        }, {}),
        burstWallMs,
        nonOkSamples: [...burstAttempts, ...probes]
          .filter((attempt) => attempt.status !== 200)
          .slice(0, 10)
          .map((attempt) => ({ model: attempt.model, status: attempt.status, body: attempt.body.slice(0, 200) })),
        burstRetryAfter: [...new Set(burstAttempts.map((attempt) => attempt.retryAfter))],
        observedRateLimitHeaders: (() => {
          const out: Record<string, string[]> = {};
          for (const attempt of [...burstAttempts, ...probes]) {
            for (const [key, value] of Object.entries(attempt.rateLimitHeaders)) {
              const list = (out[key] ??= []);
              if (!list.includes(value)) list.push(value);
            }
          }
          return out;
        })(),
        probeResults: probes.map((attempt) => ({ model: attempt.model, status: attempt.status, kind: attempt.kind, retryAfter: attempt.retryAfter, body: attempt.body.slice(0, 160) })),
        probeRateLimited,
        actualCalls,
        projectedCalls,
        overBudget,
        note: "One account: per-account and per-provider are indistinguishable; the answer is per-model vs shared.",
      },
      null,
      2,
    ),
  );
  process.exit(overBudget ? 1 : conclusive ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
