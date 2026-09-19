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
