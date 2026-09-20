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
export type GymRunnerKind = "local" | "sandbox";
/** The boundary a run actually had, written into every result artifact. */
export type GymIsolation = "unisolated" | "gvisor";
export interface GymRunnerBinding {
    kind: GymRunnerKind;
    isolation: GymIsolation;
    /** True only for the gVisor pod. Local is never isolated. */
    isolated: boolean;
    /**
     * Whether a scored attempt may run on this runner. False for `local`: the
     * agent's process can read `hidden.cases.json` on the host, so a score from it
     * would be a ground-truth leak.
     */
    scoredAllowed: boolean;
    /** Human-readable label for artifacts and logs. `unisolated` or `gvisor`. */
    label: GymIsolation;
}
/** The only default: agent code runs in the gVisor sandbox, synth runs included. */
export declare const DEFAULT_GYM_RUNNER: GymRunnerKind;
export declare function describeGymRunner(kind: GymRunnerKind): GymRunnerBinding;
/**
 * Coerce a user-supplied `--runner` value. Only the two known kinds are accepted;
 * anything else is a loud error rather than a silent fall back to the default.
 */
export declare function parseGymRunner(value: string | undefined): GymRunnerKind;
/** Raised when a scored run is asked to proceed on an unisolated runner. */
export declare class UnisolatedScoredRunError extends Error {
    constructor(kind: GymRunnerKind);
}
/** Throw unless a scored attempt is allowed on this runner. */
export declare function assertScoredRunnerAllowed(kind: GymRunnerKind): void;
