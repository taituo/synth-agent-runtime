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
