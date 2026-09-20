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
  /** Sandbox image pinned by digest (git-capable). */
  image: string;
  namespace?: string;
  kubectlContext?: string;
  runtimeClassName?: string;
  fixtureCacheDir?: string;
}

export interface GymAttemptActivityOutput {
  arm: "durable";
  outcome: "passed" | "failed" | "tampered" | "timed-out" | "errored";
  requestedModel: string | null;
  servedModel: string | null;
  modelSubstituted: boolean;
  wallTimeMs: number;
  callCount: number;
  turns: number;
  protectedPathsTouched: string[];
  detail?: string;
  error?: string;
}

export interface GymAttemptActivities {
  runGymAttemptActivity(input: GymAttemptActivityInput): Promise<GymAttemptActivityOutput>;
}
