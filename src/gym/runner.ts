/**
 * Which physical boundary the agent's effects run in, named explicitly.
 *
 * The product is an untrusted agent in a durable, sandboxed workflow, so
 * `sandbox` (the gVisor pod) is the ONLY default. The local host runner survives
 * only as a labelled comparison arm for unscored/dry runs: model-authored code
 * executing as the host user can read the held-out vectors and the host
 * filesystem, so a local run is `unisolated` and a scored run must be refused.
 * Nothing in this module pretends a host run is isolated.
 */
import { scoredRungAllowed } from "../execution/scored-rung.js";

export type GymRunnerKind = "local" | "sandbox";

/** The boundary a run actually had, written into every result artifact. */
export type GymIsolation = "unisolated" | "gvisor";

export interface GymRunnerBinding {
  kind: GymRunnerKind;
  isolation: GymIsolation;
  /**
   * True only for the gVisor pod. Local is never isolated. This is the single
   * field the scored rule reads (`scoredRungAllowed`); there is deliberately no
   * separate `scoredAllowed` flag to drift out of agreement with it.
   */
  isolated: boolean;
  /** Human-readable label for artifacts and logs. `unisolated` or `gvisor`. */
  label: GymIsolation;
}

/** The only default: agent code runs in the gVisor sandbox, synth runs included. */
export const DEFAULT_GYM_RUNNER: GymRunnerKind = "sandbox";

export function describeGymRunner(kind: GymRunnerKind): GymRunnerBinding {
  if (kind === "sandbox") {
    return { kind, isolation: "gvisor", isolated: true, label: "gvisor" };
  }
  return { kind, isolation: "unisolated", isolated: false, label: "unisolated" };
}

/**
 * Coerce a user-supplied `--runner` value. Only the two known kinds are accepted;
 * anything else is a loud error rather than a silent fall back to the default.
 */
export function parseGymRunner(value: string | undefined): GymRunnerKind {
  if (value === undefined || value === "") return DEFAULT_GYM_RUNNER;
  if (value === "local" || value === "sandbox") return value;
  throw new Error(`unknown runner "${value}": expected "sandbox" (default, gVisor) or "local" (unisolated comparison arm)`);
}

/** Raised when a scored run is asked to proceed on an unisolated runner. */
export class UnisolatedScoredRunError extends Error {
  constructor(kind: GymRunnerKind) {
    super(
      `refusing to score a run on the "${kind}" runner: it is unisolated and model-authored code can read the held-out ` +
        `vectors on the host. Re-run with --runner sandbox (gVisor), or use --dry-run for the labelled unscored arm.`,
    );
    this.name = "UnisolatedScoredRunError";
  }
}

/** Throw unless a scored attempt is allowed on this runner. */
export function assertScoredRunnerAllowed(kind: GymRunnerKind): void {
  if (!scoredRungAllowed(describeGymRunner(kind), true)) throw new UnisolatedScoredRunError(kind);
}
