/**
 * Parse a server rate-limit retry hint from response headers.
 *
 * Single source of truth for the runtime. The Temporal integration imports this
 * rather than keeping its own copy. The stack-router integration is a separate
 * package with its own dependency boundary and keeps a standalone copy; a
 * differential test feeds both the same header sets and asserts they agree, so
 * the two cannot drift apart silently.
 *
 * Returns milliseconds (possibly negative or absurdly large); the caller clamps
 * before using it. The `Date` header, when present, is the reference clock for
 * absolute resets so worker clock skew cannot produce a bad wait.
 */
export function parseRetryHintMs(headers, now = Date.now()) {
    const retryAfter = headers.get("retry-after");
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds))
            return Math.round(seconds * 1000);
        const at = Date.parse(retryAfter);
        if (Number.isFinite(at))
            return at - referenceNow(headers, now);
    }
    for (const name of ["x-ratelimit-reset", "x-rate-limit-reset", "ratelimit-reset"]) {
        const raw = headers.get(name);
        if (!raw)
            continue;
        const value = Number(raw);
        if (!Number.isFinite(value))
            continue;
        const serverNow = referenceNow(headers, now);
        // Common forms: epoch milliseconds, epoch seconds, or seconds from now.
        if (value > 10_000_000_000)
            return value - serverNow;
        if (value > 1_000_000_000)
            return value * 1000 - serverNow;
        return value * 1000;
    }
    return undefined;
}
export function referenceNow(headers, fallback) {
    const date = headers.get("date");
    if (date) {
        const parsed = Date.parse(date);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
