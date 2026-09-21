/**
 * The ONE scored-rung rule.
 *
 * A run graded against held-out ground truth must execute its effects in an
 * isolated (trust-boundary) rung. The runtime turn guard
 * (`assertRungAllowedForScored`) and the gym driver guard
 * (`assertScoredRunnerAllowed`) both call this predicate, so there is no second
 * `scoredAllowed` flag that could drift out of agreement with `isolated`.
 */
export interface RungIsolation {
  /** True only when every effect executes inside the trust boundary. */
  isolated?: boolean;
}

/** True when the run is unscored, or the rung is isolated. */
export function scoredRungAllowed(rung: RungIsolation, scored: boolean): boolean {
  return !scored || rung.isolated === true;
}
