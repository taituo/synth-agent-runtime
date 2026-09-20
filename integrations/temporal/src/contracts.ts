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
  /**
   * Optional per-agent turn configuration, carried through the workflow into
   * the `runTurn` activity: the system prompt, the tool surface (each tool maps
   * to one execution-rung effect), and the rung the tool calls run on. Omitted
   * by the triage callers, which get the classification turn.
   */
  turnConfig?: DurableTurnConfig;
}

/** A tool the durable turn may run, mapped to exactly one execution-rung effect. */
export interface DurableToolSpec {
  name: string;
  /** The execution-rung effect kind this tool maps to. */
  effect: "workspace.read" | "workspace.write" | "workspace.list" | "workspace.delete" | "process.exec";
  /** Argument name carrying the path for `workspace.*`; default `path`. */
  pathArg?: string;
  /** Argument name carrying the content for `workspace.write`; default `content`. */
  contentArg?: string;
  /** Argument name carrying the command for `process.exec`; default `command`. */
  commandArg?: string;
  /** Argument name carrying the working directory for `process.exec`; default `cwd`. */
  cwdArg?: string;
  /** Argument name carrying the timeout in ms for `process.exec`; default `timeoutMs`. */
  timeoutArg?: string;
  /** Optional resource class for `process.exec` (sandbox rung). */
  resourceClass?: string;
}

/**
 * Which rung the turn's tool calls run on. `synthetic` is the cheap in-memory
 * workspace; `sandbox` escalates `process.exec` to the Kubernetes/gVisor
 * executor. `none` (or omitted) means no rung, so tool calls are refused.
 */
export type DurableRungConfig =
  | { kind: "none" }
  | { kind: "synthetic"; workspaceId?: string; files?: Record<string, string> }
  | { kind: "sandbox"; namespace?: string; image?: string; kubectlContext?: string; files?: Record<string, string> };

export interface DurableTurnConfig {
  /** System prompt for the turn. Defaults to the event-triage prompt. */
  systemPrompt?: string;
  /** Tool surface. When non-empty the turn returns tool observations, not classifications. */
  tools?: DurableToolSpec[];
  /** The execution rung for tool calls. Omitted means tool calls are refused. */
  rung?: DurableRungConfig;
}

export interface RunTurnInput {
  agentId: string;
  messages: DurableMailboxMessage[];
  /** Per-agent turn configuration (system prompt, tools, rung). */
  config?: DurableTurnConfig;
}

export interface RunTurnResult {
  result?: unknown;
  state?: "idle" | "waiting" | "completed";
}

export interface AgentActivities {
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
}

/** Input for a generic graph activity node. */
export interface GraphActivityInput {
  name: string;
  input?: unknown;
}

/**
 * Activities the graph workflow may call for `activity` nodes. Optional: a
 * worker that only runs `durableAgentWorkflow` need not supply it, and a graph
 * with no activity nodes never calls it.
 */
export interface GraphActivities {
  graphActivity(input: GraphActivityInput): Promise<unknown>;
}
