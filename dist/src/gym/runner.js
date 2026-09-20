/** The only default: agent code runs in the gVisor sandbox, synth runs included. */
export const DEFAULT_GYM_RUNNER = "sandbox";
export function describeGymRunner(kind) {
    if (kind === "sandbox") {
        return { kind, isolation: "gvisor", isolated: true, scoredAllowed: true, label: "gvisor" };
    }
    return { kind, isolation: "unisolated", isolated: false, scoredAllowed: false, label: "unisolated" };
}
/**
 * Coerce a user-supplied `--runner` value. Only the two known kinds are accepted;
 * anything else is a loud error rather than a silent fall back to the default.
 */
export function parseGymRunner(value) {
    if (value === undefined || value === "")
        return DEFAULT_GYM_RUNNER;
    if (value === "local" || value === "sandbox")
        return value;
    throw new Error(`unknown runner "${value}": expected "sandbox" (default, gVisor) or "local" (unisolated comparison arm)`);
}
/** Raised when a scored run is asked to proceed on an unisolated runner. */
export class UnisolatedScoredRunError extends Error {
    constructor(kind) {
        super(`refusing to score a run on the "${kind}" runner: it is unisolated and model-authored code can read the held-out ` +
            `vectors on the host. Re-run with --runner sandbox (gVisor), or use --dry-run for the labelled unscored arm.`);
        this.name = "UnisolatedScoredRunError";
    }
}
/** Throw unless a scored attempt is allowed on this runner. */
export function assertScoredRunnerAllowed(kind) {
    if (!describeGymRunner(kind).scoredAllowed)
        throw new UnisolatedScoredRunError(kind);
}
