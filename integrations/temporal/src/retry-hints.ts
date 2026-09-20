/**
 * Parse a server rate-limit retry hint from response headers.
 *
 * This mirrors the parsing already used by
 * `src/inference/gateway/profile-router-backend.ts` (retry-after) and
 * `integrations/pi-opencode-stack-router` (retry-after plus the
 * `*-ratelimit-reset` spellings). It is a local copy only because this
 * integration is a standalone package that does not depend on either; the
 * logic is deliberately the same, not a third independent design.
 *
 * Returns milliseconds (possibly negative or absurdly large); the workflow
 * clamps before using it. `Date` header, when present, is the reference clock
 * for absolute resets so worker clock skew cannot produce a bad wait.
 */
export function parseRetryHintMs(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return at - referenceNow(headers, now);
  }

  for (const name of ["x-ratelimit-reset", "x-rate-limit-reset", "ratelimit-reset"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const serverNow = referenceNow(headers, now);
    // Common forms: epoch milliseconds, epoch seconds, or seconds from now.
    if (value > 10_000_000_000) return value - serverNow;
    if (value > 1_000_000_000) return value * 1000 - serverNow;
    return value * 1000;
  }
  return undefined;
}

function referenceNow(headers: Headers, fallback: number): number {
  const date = headers.get("date");
  if (date) {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
