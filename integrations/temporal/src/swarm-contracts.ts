/**
 * Contracts between the durable swarm workflow and its activity. Types only, so
 * the workflow isolate can `import type` this without dragging in `node:*`.
 */
export interface SwarmAttemptActivityInput {
  agentId: string;
  /** Host scratch directory the event stream is materialized into. */
  workDir: string;
  /** Gateway base URL (no trailing slash). */
  gatewayBaseUrl: string;
  model: string;
  apiKey?: string;
  maxTurns: number;
  deadlineMs: number;
  /** Per-model-request timeout. */
  gatewayTimeoutMs?: number;
  /** Stable key so a retried activity resumes from the last checkpoint. */
  checkpointKey?: string;
}

export interface SwarmAttemptActivityOutput {
  arm: "durable";
  recovered: number;
  planted: number;
  recall: number;
  precision: number;
  spurious: number;
  decoyReports: number;
  ambiguousReports: number;
  turns: number;
  finished: boolean;
  toolCalls: number;
  requestedModel: string | null;
  servedModel: string | null;
  modelSubstituted: boolean;
  wallTimeMs: number;
  /** Turn the attempt resumed from, when a checkpoint existed. */
  resumedFromTurn?: number;
  /** Per-turn trace, capped, for post-mortem of a fault run. */
  trace?: string[];
  error?: string;
}

export interface SwarmAttemptActivities {
  runSwarmAttemptActivity(input: SwarmAttemptActivityInput): Promise<SwarmAttemptActivityOutput>;
}
