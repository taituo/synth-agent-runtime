/**
 * Standalone copy of the runtime's retry-hint parsing.
 *
 * This package is an overlay into Pi's tree with its own dependency boundary,
 * so it cannot import `src/inference/gateway/retry-hint.ts`. It must implement
 * the SAME algorithm; `integrations/temporal/test/retry-hint-parity.test.ts`
 * feeds both this and the canonical parser identical header sets and fails if
 * they disagree, so they cannot drift apart silently.
 *
 * Returns milliseconds (possibly negative or absurdly large); the caller clamps.
 */
export function parseRetryAfterMs(headers: Record<string, string> | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | undefined =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const referenceNow = (): number => {
    const date = get("date");
    if (date) {
      const parsed = Date.parse(date);
      if (Number.isFinite(parsed)) return parsed;
    }
    return now;
  };

  const retryAfter = get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return at - referenceNow();
  }

  for (const name of ["x-ratelimit-reset", "x-rate-limit-reset", "ratelimit-reset"]) {
    const raw = get(name);
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const serverNow = referenceNow();
    if (value > 10_000_000_000) return value - serverNow;
    if (value > 1_000_000_000) return value * 1000 - serverNow;
    return value * 1000;
  }
  return undefined;
}
