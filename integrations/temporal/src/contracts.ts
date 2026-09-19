/** One durable mailbox message, delivered via the `sendMessage` signal. */
export interface DurableMailboxMessage {
  id: string;
  role: "human" | "agent" | "system";
  text: string;
  createdAt: number;
  /**
   * Optional typed-event tag (e.g. "social_post" | "incident" | "news").
   * Free-form string. Omitted for legacy untyped signals, so existing callers
   * and state are unaffected.
   */
  kind?: string;
}

export interface DurableAgentState {
  agentId: string;
  status: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  mailbox: DurableMailboxMessage[];
  lastResult?: unknown;
  lastError?: string;
  updatedAt: number;
  /**
   * Optional per-agent park backoff override. When a transient turn failure
   * exhausts the activity retry policy the agent parks (`waiting`) and retries
   * with exponential backoff; this overrides the defaults (5s initial, x2,
   * capped at 5 min). Omitted by legacy callers, which get the defaults.
   */
  parkBackoff?: { initialMs: number; maxMs: number };
}

export interface RunTurnInput {
  agentId: string;
  messages: DurableMailboxMessage[];
}

export interface RunTurnResult {
  result?: unknown;
  state?: "idle" | "waiting" | "completed";
}

export interface AgentActivities {
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
}
