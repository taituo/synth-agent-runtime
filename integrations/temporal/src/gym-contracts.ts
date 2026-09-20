/**
 * Contracts between the durable gym workflow and its activity. Types only, so
 * the workflow isolate can `import type` this without dragging in `node:*`.
 */
import type { DurableToolSpec } from "./contracts.js";

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

// --- Turn-per-activity loop --------------------------------------------------
// The workflow owns the loop; each turn is its own `runTurn` activity, so the
// transcript continues across activities and a worker restart re-runs at most
// the in-flight turn.

/** One transcript entry the workflow carries between turns. */
export interface GymTranscriptMessage {
  role: "assistant" | "tool";
  name?: string;
  content: string;
}

/** A model tool call the turn asked for (shape shared with the runtime engine). */
export interface GymTurnToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface GymTurnObservation {
  name: string;
  ok: boolean;
  /**
   * The observation as TEXT the model can read. The rung returns bytes for
   * `read_file`; rendering them as `{"type":"Buffer","data":[...]}` made the
   * model unable to read the source (found live: the durable arm scored 0 B
   * while the plain arm scored the fix).
   */
  content: string;
}

/** What the prepare activity hands to every turn activity. */
export interface GymPreparedAttempt {
  attempt: GymAttemptActivityInput;
  /** Host checkout of the bugged commit; the workspace source for the rung. */
  repoDir: string;
  /** Same checkout, named for the scorer. */
  baseRepoDir: string;
  /** Repo-relative visible test path. */
  visibleTestPath: string;
  systemPrompt: string;
  userPrompt: string;
  /** Serializable tool surface, mapped to rung effects by `buildToEffect`. */
  tools: DurableToolSpec[];
  checkpointKey: string;
}

export interface GymTurnActivityInput {
  prepared: GymPreparedAttempt;
  turn: number;
  transcript: GymTranscriptMessage[];
}

export interface GymTurnActivityResult {
  content: string;
  toolCalls: GymTurnToolCall[];
  observations: GymTurnObservation[];
  /** True when the model called the `finish` tool this turn. */
  finished: boolean;
  /** The agent's patch after this turn, harvested from the rung. */
  patch: string;
  requestedModel: string | null;
  servedModel: string | null;
  modelSubstituted: boolean;
  latencyMs: number;
  /** HTTP attempts this turn made (1 unless the engine retried). */
  httpAttempts: number;
}

export interface GymScoreActivityInput {
  prepared: GymPreparedAttempt;
  patch: string;
  turns: number;
  callCount: number;
  httpAttempts: number;
  requestedModel: string | null;
  servedModel: string | null;
  modelSubstituted: boolean;
  wallTimeMs: number;
  error?: string;
}

/** Activities the turn-per-activity gym workflow proxies. */
export interface GymActivities {
  gymPrepareActivity(input: GymAttemptActivityInput): Promise<GymPreparedAttempt>;
  runTurn(input: GymTurnActivityInput): Promise<GymTurnActivityResult>;
  gymScoreActivity(input: GymScoreActivityInput): Promise<GymAttemptActivityOutput>;
}
