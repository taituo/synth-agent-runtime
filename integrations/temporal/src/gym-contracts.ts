/**
 * Contracts between the durable gym workflow and its activity. Types only, so
 * the workflow isolate can `import type` this without dragging in `node:*`.
 */
export interface GymAttemptActivityInput {
  agentId: string;
  /** Fixture directory holding task.json/bug.patch/visible/hidden tests. */
  taskDir: string;
  /** Host scratch directory the bugged checkout is materialized into. */
  workDir: string;
  /** Gateway base URL (no trailing slash). */
  gatewayBaseUrl: string;
  model: string;
  apiKey?: string;
  maxTurns: number;
  deadlineMs: number;
  /**
   * "local" runs the tools on the host checkout; "sandbox" runs them in the
   * Kubernetes/gVisor Pod. Both arms of a comparison must use the same value.
   */
  runner?: "local" | "sandbox";
  /** Per-model-request timeout. */
  gatewayTimeoutMs?: number;
  /**
   * Bounded transient retry per turn. Omitted (or 1) is the single-shot turn;
   * both arms must pass the same value for the comparison to isolate durability.
   */
  retryMaxAttempts?: number;
  /**
   * Stable key for work-product checkpoints. The same value on the retried
   * activity makes it resume from the last checkpoint instead of the base.
   */
  checkpointKey?: string;
  /** Sandbox image pinned by digest (git-capable), for runner="sandbox". */
  image: string;
  namespace?: string;
  kubectlContext?: string;
  runtimeClassName?: string;
  fixtureCacheDir?: string;
}

export interface GymAttemptActivityOutput {
  arm: "durable";
  /**
   * The boundary the attempt actually had. `unisolated` is set even when the
   * attempt is refused, so the artifact never presents a host run as isolated.
   */
  isolation?: "unisolated" | "gvisor";
  outcome: "passed" | "failed" | "tampered" | "timed-out" | "errored" | "skipped";
  requestedModel: string | null;
  servedModel: string | null;
  modelSubstituted: boolean;
  wallTimeMs: number;
  callCount: number;
  turns: number;
  /** HTTP attempts summed across turns; > callCount only when a turn retried. */
  httpAttempts?: number;
  protectedPathsTouched: string[];
  /** Byte length of the harvested patch, so arms can be compared. */
  patchBytes?: number;
  /** Turn the attempt resumed from, when a checkpoint existed. */
  resumedFromTurn?: number;
  /** Per-turn assistant/tool trace, capped, for post-mortem of a fault run. */
  trace?: string[];
  detail?: string;
  error?: string;
}

export interface GymAttemptActivities {
  runGymAttemptActivity(input: GymAttemptActivityInput): Promise<GymAttemptActivityOutput>;
}
