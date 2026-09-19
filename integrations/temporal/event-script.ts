/**
 * Fixed, ordered typed-event schedules for the durable agent workflow, plus the
 * pure helpers that make a scripted run's result comparable across runs.
 *
 * Kept separate from `event-driver.ts` (the runnable tool) so the deterministic
 * projection can be unit-tested without a Temporal client or dev server.
 */
import type { DurableAgentState } from "./src/contracts.js";

export interface ScriptedEvent {
  /** Typed-event tag delivered as the signal's `kind`. */
  kind: string;
  /** Message body handed to the agent for this event. */
  text: string;
  /** Delay before this event is fired, relative to the previous event. */
  delayMs: number;
}

/** A mini fault/event timeline, spaced out rather than fired as one burst. */
export const EVENT_SCRIPT: readonly ScriptedEvent[] = [
  { delayMs: 0, kind: "news", text: "market moved 2% on open" },
  { delayMs: 250, kind: "social_post", text: "influencer mentions the ticker" },
  { delayMs: 250, kind: "incident", text: "upstream feed timed out once" },
  { delayMs: 400, kind: "news", text: "exchange confirms normal operation" },
];

/** Structural subset of a trace event needed to recover the processed order. */
export interface TraceLikeEvent {
  name: string;
  phase: string;
  attributes?: Record<string, unknown>;
}

/** Structural subset of a log entry needed to check correlation isolation. */
export interface LogLikeEntry {
  message: string;
  meta?: Record<string, unknown>;
}

export interface SwarmScript {
  /** Short label, used to build the instance's agentId. */
  name: string;
  /** This instance's own ordered event stream. */
  script: readonly ScriptedEvent[];
}

/**
 * Distinct per-instance schedules for the small swarm. Kept to three agents so
 * a shared dev server/worker is never load-bombed.
 */
export const SWARM_SCRIPTS: readonly SwarmScript[] = [
  {
    name: "news",
    script: [
      { delayMs: 0, kind: "news", text: "market moved 2% on open" },
      { delayMs: 200, kind: "social_post", text: "influencer mentions the ticker" },
      { delayMs: 200, kind: "incident", text: "upstream feed timed out once" },
      { delayMs: 300, kind: "news", text: "exchange confirms normal operation" },
    ],
  },
  {
    name: "incident",
    script: [
      { delayMs: 0, kind: "incident", text: "latency spike on the order book" },
      { delayMs: 250, kind: "incident", text: "second probe also slow" },
      { delayMs: 250, kind: "news", text: "status page updated" },
    ],
  },
  {
    name: "social",
    script: [
      { delayMs: 0, kind: "social_post", text: "thread is trending" },
      { delayMs: 300, kind: "social_post", text: "reply count rising" },
      { delayMs: 300, kind: "news", text: "coverage picked it up" },
      { delayMs: 300, kind: "social_post", text: "sentiment turning positive" },
    ],
  },
];

/** Final state with volatile ids/timestamps stripped, for run-to-run compare. */
export function projectFinalState(state: DurableAgentState) {
  return {
    status: state.status,
    mailbox: state.mailbox.map((message) => ({
      role: message.role,
      text: message.text,
      kind: message.kind ?? null,
    })),
    lastResult: state.lastResult ?? null,
    lastError: state.lastError ?? null,
  };
}

/** Ordered kinds of turns actually processed, read from activity start spans. */
export function sequenceFromTrace(events: readonly TraceLikeEvent[], agentId: string): string[] {
  return events
    .filter(
      (event) =>
        event.phase === "start" &&
        event.name === "temporal.activity.runTurn" &&
        event.attributes?.agentId === agentId,
    )
    .map((event) => (typeof event.attributes?.messageKind === "string" ? event.attributes.messageKind : "untyped"));
}

export interface ScriptedRun {
  final: ReturnType<typeof projectFinalState>;
  processed: string[];
}

function workflowIdOf(agentId: string): string {
  return `agent/${agentId}`;
}

/**
 * Cross-contamination check for a concurrent swarm: every trace event must
 * belong to one of the known agents, and must never pair one agent's id with
 * another agent's workflow id. Returns human-readable violations (empty = ok).
 */
export function swarmIsolationViolations(events: readonly TraceLikeEvent[], agentIds: readonly string[]): string[] {
  const ids = new Set(agentIds);
  const violations: string[] = [];
  for (const event of events) {
    const agentId = event.attributes?.agentId;
    const workflowId = event.attributes?.workflowId;
    if (typeof agentId !== "string" || !ids.has(agentId)) {
      violations.push(`trace event ${event.name} has unexpected agentId ${String(agentId)}`);
      continue;
    }
    if (typeof workflowId === "string" && workflowId !== workflowIdOf(agentId) && workflowId !== agentId) {
      violations.push(`agent ${agentId} emitted workflowId ${workflowId}`);
    }
  }
  return violations;
}

/**
 * Same check for worker logs: a log line tagged with a swarm workflow id must
 * carry that same agent id, and vice versa.
 */
export function logCorrelationViolations(logs: readonly LogLikeEntry[], agentIds: readonly string[]): string[] {
  const ids = new Set(agentIds);
  const violations: string[] = [];
  for (const entry of logs) {
    const meta = entry.meta;
    if (!meta) continue;
    const agentId = meta.agentId;
    const workflowId = meta.workflowId;
    if (typeof workflowId === "string" && workflowId.startsWith("agent/")) {
      const id = workflowId.slice("agent/".length);
      if (ids.has(id) && agentId !== id) {
        violations.push(`log ${entry.message} for ${workflowId} carried agentId ${String(agentId)}`);
      }
    } else if (typeof agentId === "string" && ids.has(agentId)) {
      if (typeof workflowId === "string" && workflowId !== workflowIdOf(agentId) && workflowId !== agentId) {
        violations.push(`log ${entry.message} for agent ${agentId} carried workflowId ${workflowId}`);
      }
    }
  }
  return violations;
}

/** True when two scripted sessions produced the same projection and sequence. */
export function isDeterministicReplay(a: ScriptedRun, b: ScriptedRun): boolean {
  return (
    JSON.stringify(a.final) === JSON.stringify(b.final) &&
    JSON.stringify(a.processed) === JSON.stringify(b.processed)
  );
}

/**
 * Event streams for the REAL-inference swarm. Unlike `SWARM_SCRIPTS` (whose
 * short texts are ambiguous to a real model, e.g. "status page updated"), each
 * text here has one defensible class, so a model's answer can be scored against
 * the planted `kind`. The kind is never shown to the model.
 */
export const INFERENCE_SWARM_SCRIPTS: readonly SwarmScript[] = [
  {
    name: "desk",
    script: [
      { delayMs: 0, kind: "news", text: "Reuters: central bank holds interest rates steady, citing cooling inflation." },
      { delayMs: 250, kind: "social_post", text: "omg just saw the new phone in the store, the camera is INSANE #unboxing" },
      { delayMs: 250, kind: "incident", text: "ALERT: checkout service returning HTTP 503 for 62% of requests since 14:02 UTC, on-call paged." },
      { delayMs: 400, kind: "news", text: "Company confirms quarterly earnings will be released next Tuesday after market close." },
    ],
  },
  {
    name: "ops",
    script: [
      { delayMs: 0, kind: "incident", text: "PagerDuty: database primary failover triggered, replication lag at 90 seconds." },
      { delayMs: 250, kind: "incident", text: "ALERT: disk usage at 98% on log-ingest-3, writes are failing." },
      { delayMs: 250, kind: "news", text: "AP: regulators publish new guidance on data retention requirements for cloud providers." },
      { delayMs: 300, kind: "incident", text: "ALERT: TLS certificate for api.example.com expires in 2 hours and automatic renewal is failing." },
    ],
  },
  {
    name: "feed",
    script: [
      { delayMs: 0, kind: "social_post", text: "lol my cat just knocked the router off the shelf again #catsofinstagram" },
      { delayMs: 300, kind: "social_post", text: "anyone else think this new season is way better than the last one?? fight me #tvtwitter" },
      { delayMs: 300, kind: "news", text: "BBC: storm warning issued for coastal regions ahead of the weekend." },
      { delayMs: 300, kind: "social_post", text: "just ran my first 10k!!! so proud of myself #running" },
    ],
  },
];

/** Structural subset of a gateway turn record needed for scoring. */
export interface ScorableTurn {
  plantedKinds: ReadonlyArray<string | null>;
  classifications: ReadonlyArray<{ classification: string }>;
}

export interface ClassificationMismatch {
  index: number;
  text: string;
  planted: string;
  got: string;
}

export interface ScriptScore {
  /** Events the script contained. */
  expected: number;
  /** Events the turns actually classified. */
  classified: number;
  correct: number;
  /** correct / expected (0 when the script is empty). */
  accuracy: number;
  mismatches: ClassificationMismatch[];
  /**
   * True when the turns, concatenated in order, covered exactly the script's
   * events in order: nothing lost, duplicated or reordered by batching.
   */
  orderOk: boolean;
}

/** Scores an agent's turns (in completion order) against its planted script. */
export function scoreAgainstScript(script: readonly ScriptedEvent[], turns: readonly ScorableTurn[]): ScriptScore {
  const plantedFlat = turns.flatMap((turn) => [...turn.plantedKinds]);
  const gotFlat = turns.flatMap((turn) => turn.classifications.map((entry) => entry.classification));
  const orderOk =
    plantedFlat.length === script.length &&
    script.every((event, index) => plantedFlat[index] === event.kind) &&
    gotFlat.length === plantedFlat.length;

  const mismatches: ClassificationMismatch[] = [];
  let correct = 0;
  script.forEach((event, index) => {
    const got = gotFlat[index];
    if (got === event.kind) correct++;
    else mismatches.push({ index, text: event.text, planted: event.kind, got: got ?? "(missing)" });
  });
  return {
    expected: script.length,
    classified: gotFlat.length,
    correct,
    accuracy: script.length === 0 ? 0 : correct / script.length,
    mismatches,
    orderOk,
  };
}
