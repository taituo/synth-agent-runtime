export interface DurableAgentState {
  agentId: string;
  status: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  mailbox: Array<{ id: string; role: "human" | "agent" | "system"; text: string; createdAt: number }>;
  lastResult?: unknown;
  lastError?: string;
  updatedAt: number;
}

export interface RunTurnInput {
  agentId: string;
  messages: DurableAgentState["mailbox"];
}

export interface RunTurnResult {
  result?: unknown;
  state?: "idle" | "waiting" | "completed";
}

export interface AgentActivities {
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
}
