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

/** True when two scripted sessions produced the same projection and sequence. */
export function isDeterministicReplay(a: ScriptedRun, b: ScriptedRun): boolean {
  return (
    JSON.stringify(a.final) === JSON.stringify(b.final) &&
    JSON.stringify(a.processed) === JSON.stringify(b.processed)
  );
}
