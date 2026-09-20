/**
 * Does an observed park actually track the server's retry hint?
 *
 * The real-429 proof used to assert only that the agent was seen `waiting`,
 * which a fixed-backoff implementation also satisfies. This is the
 * discriminating quantity: the observed wait must be at least the parsed hint
 * (minus a tolerance for polling granularity), or the hint was ignored.
 */
export function honoursRetryHint(input: { longestWaitMs: number; hintMs: number | undefined; toleranceMs: number }): boolean {
  const { longestWaitMs, hintMs, toleranceMs } = input;
  if (hintMs === undefined || !Number.isFinite(hintMs) || hintMs <= 0) return false;
  return longestWaitMs >= hintMs - Math.max(0, toleranceMs);
}
