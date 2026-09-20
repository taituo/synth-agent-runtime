/**
 * Contracts for the durable interactive-session supervisor (roadmap item 5).
 *
 * This is a supervisor that watches agent sessions (tmux panes / herdr panes)
 * and pokes them: one workflow per session, durable check-ins, signals for
 * human redirection, and escalation when a session stays blocked. It runs on a
 * SEPARATE Temporal deployment from the runtime it supervises, so restarting
 * the system under test cannot take its own supervisor down.
 *
 * Be honest about what it is: a supervisor that watches workers and nudges
 * them. Useful, and slightly Orwellian.
 */

/** What a probe can say about a session. `unknown` is a real answer, not a guess. */
export type SessionStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type ProbeKind = "tmux" | "herdr";

export interface SessionMarkers {
  /** Text that means the agent is busy (tmux fallback only). */
  working?: string;
  /** Text that means the agent is waiting for a human (tmux fallback only). */
  blocked?: string;
}

export interface ProbeResult {
  status: SessionStatus;
  /** Short evidence for the decision (a pane line or the raw state document). */
  evidence: string;
  /** Which probe produced it, so a tmux guess is never mistaken for a real state. */
  probe: ProbeKind;
}

export interface PokeResult {
  /** True only if the text was seen in the pane after sending; never assume. */
  delivered: boolean;
  attempts: number;
  evidence: string;
}

export interface SupervisorInput {
  sessionId: string;
  /** tmux target (e.g. "synth-gym:0.0") or herdr pane id. */
  target: string;
  probeKind?: ProbeKind;
  /** Periodic check-in interval. */
  checkInMs: number;
  /** Escalate when a session has been `blocked` at least this long. */
  blockedThresholdMs: number;
  /** Cap escalations so a permanently-blocked session is not poked forever. */
  maxEscalations?: number;
  markers?: SessionMarkers;
}

export interface SupervisorState {
  sessionId: string;
  target: string;
  status: SessionStatus;
  checkIns: number;
  lastProbeAt?: number;
  lastEvidence?: string;
  /** When the session first became blocked in the current run of blocked probes. */
  blockedSince?: number;
  escalations: number;
  pokes: number;
  lastPokeAt?: number;
  lastRedirect?: string;
  paused: boolean;
  stopped: boolean;
  updatedAt: number;
}

export interface ProbeSessionInput {
  target: string;
  probeKind?: ProbeKind;
  markers?: SessionMarkers;
}

export interface PokeSessionInput {
  target: string;
  text: string;
  probeKind?: ProbeKind;
}

export interface EscalateInput {
  sessionId: string;
  target: string;
  status: SessionStatus;
  blockedMs: number;
  escalations: number;
  probeKind?: ProbeKind;
  markers?: SessionMarkers;
}

export interface EscalateResult {
  delivered: boolean;
  evidence: string;
}

export interface SupervisorActivities {
  probeSession(input: ProbeSessionInput): Promise<ProbeResult>;
  pokeSession(input: PokeSessionInput): Promise<PokeResult>;
  escalate(input: EscalateInput): Promise<EscalateResult>;
}

/** Default check-in interval: the 30 minutes the manual monitor used. */
export const DEFAULT_CHECK_IN_MS = 30 * 60_000;
/** Default blocked threshold: two check-ins without progress. */
export const DEFAULT_BLOCKED_THRESHOLD_MS = 60 * 60_000;
export const DEFAULT_MAX_ESCALATIONS = 3;
