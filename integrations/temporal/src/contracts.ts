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
  /**
   * Optional Temporal search attributes to upsert for this workflow, so a run
   * is queryable by them (`agentId`, `runId` and the final `outcome` are added
   * by the workflow itself). Opt-in because the attribute names must be
   * registered on the namespace first (see `SYNTH_SEARCH_ATTRIBUTES` and
   * `docs/OBSERVABILITY.md`); callers that omit it set no custom attributes.
   */
  searchAttributes?: Record<string, string>;
}

/**
 * The search attributes the runtime knows how to emit, with their Temporal
 * types, for registration on a namespace:
 *
 *   temporal operator search-attribute create --name agentId --type Keyword ...
 *
 * `runId` and `workflowId` are already queryable as built-in execution fields.
 */
export const SYNTH_SEARCH_ATTRIBUTES: ReadonlyArray<{ name: string; type: "Keyword" | "Text" | "Int" | "Double" | "Bool" | "Datetime" }> = [
  { name: "agentId", type: "Keyword" },
  { name: "runId", type: "Keyword" },
  { name: "taskSlug", type: "Keyword" },
  { name: "rung", type: "Keyword" },
  { name: "isolation", type: "Keyword" },
  { name: "provider", type: "Keyword" },
  { name: "model", type: "Keyword" },
  { name: "outcome", type: "Keyword" },
];

/** A tool the durable turn may run, mapped to exactly one execution-rung effect. */
export interface DurableToolSpec {
  name: string;
  /** The execution-rung effect kind this tool maps to. */
  effect: "workspace.read" | "workspace.write" | "workspace.replace" | "workspace.list" | "workspace.delete" | "process.exec";
  /** Argument name carrying the path for `workspace.*`; default `path`. */
  pathArg?: string;
  /** Argument name carrying the content for `workspace.write`; default `content`. */
  contentArg?: string;
  /** Argument name carrying the old text for `workspace.replace`; default `old_text`. */
  oldTextArg?: string;
  /** Argument name carrying the new text for `workspace.replace`; default `new_text`. */
  newTextArg?: string;
  /** Argument name carrying the command for `process.exec`; default `command`. */
  commandArg?: string;
  /**
   * A FIXED command for `process.exec`, for a tool the model invokes with no
   * command argument (e.g. the gym's `run_visible_test`). Overrides `commandArg`.
   */
  command?: string;
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
  /**
   * Whether the turn's output is scored (graded against held-out ground truth).
   * A scored turn must run in a trust boundary, so `runTurn` refuses an
   * unisolated rung (the synthetic/worker-RAM one) via
   * `assertRungAllowedForScored`. Defaults to false for cheap, unscored runs.
   */
  scored?: boolean;
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
