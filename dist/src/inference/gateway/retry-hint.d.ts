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
export declare function parseRetryHintMs(headers: Headers, now?: number): number | undefined;
export declare function referenceNow(headers: Headers, fallback: number): number;
