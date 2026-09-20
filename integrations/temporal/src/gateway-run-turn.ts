import { ApplicationFailure, Context as ActivityContext } from "@temporalio/activity";
import type { AgentId, WorkspaceId } from "../../../src/core/ids.js";
import type { AgentMessage } from "../../../src/core/types.js";
import { ExecutionBroker } from "../../../src/execution/broker.js";
import { EXECUTOR_IMAGE } from "../../../src/execution/executor-image.js";
import { KubectlSandboxBackend } from "../../../src/execution/kubernetes/kubectl-backend.js";
import { WarmSandboxPool } from "../../../src/execution/kubernetes/pool.js";
import { SandboxWorkspaceExecutor } from "../../../src/execution/kubernetes/sandbox-workspace.js";
import { DEFAULT_KUBERNETES_RESOURCE_CLASSES } from "../../../src/execution/resource-class.js";
import { SyntheticExecutor } from "../../../src/execution/synthetic.js";
import type { Effect, EffectResult } from "../../../src/execution/types.js";
import type { RuntimeStateStore } from "../../../src/durability/runtime-state.js";
import type { AgentEngine, AgentEngineContext } from "../../../src/runtime/agent-engine.js";
import { recordEffect, recordModelCall } from "./metrics.js";
import { TemporalActivityStateStore } from "./receipt-store.js";
import {
  GatewayHttpError,
  createGatewayAgentEngine,
  type GatewayAgentEngineOptions,
  type GatewayToolCall,
  type GatewayToolObservation,
  type GatewayTurnOutcome,
} from "../../../src/runtime/gateway-engine.js";
import { MemoryWorkspace } from "../../../src/workspace/memory-workspace.js";
import type { AgentActivities, DurableMailboxMessage, DurableRungConfig, DurableToolSpec, RunTurnInput, RunTurnResult } from "./contracts.js";

/**
 * The `runTurn` activity. It is a thin Temporal adapter: it maps the durable
 * mailbox input into the shared turn body (`GatewayAgentEngine`, in `src/`) and
 * the turn outcome back into the workflow's result shape. It does NOT make the
 * model HTTP call itself — that would be a second turn implementation.
 *
 * Task given to the model: classify each event in the turn's batch. The typed
 * `kind` tag on a message is deliberately NEVER sent to the model, so it stays
 * a planted ground truth a driver can score the model's answers against.
 *
 * A turn can carry several messages: inference is slow relative to how fast
 * signals arrive, so events accumulate in the mailbox while a turn is in flight
 * and the next turn takes them as one batch. The model is therefore asked for
 * one classification per event, in order.
 *
 * Failure handling is intentionally plain: any HTTP error, timeout, or
 * structurally invalid answer throws, and Temporal's retry policy on the
 * workflow's activity proxy decides what happens next. While waiting on the
 * model the activity heartbeats, because the workflow configures a heartbeat
 * timeout and a slow (reasoning) model would otherwise be failed for silence.
 */

/**
 * HTTP statuses that will never succeed on retry (bad request, auth, missing
 * route/model, validation). Everything else — 408/409/425/429, 5xx, timeouts,
 * network errors, empty or malformed completions — is treated as transient and
 * left to Temporal's retry policy and, after that, the workflow's park/backoff.
 */
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 402, 403, 404, 422]);

export const EVENT_CLASSES = ["news", "social_post", "incident"] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

export interface EventClassification {
  classification: string;
  reaction: string;
}

export interface GatewayTurnRecord {
  agentId: string;
  attempt: number;
  /** Planted kinds of the messages in this batch, in order (never sent to the model). */
  plantedKinds: Array<string | null>;
  classifications: EventClassification[];
  /** The model id the runtime asked for. */
  requestedModel: string;
  /** The model id the upstream said answered, or null when it did not say. Never guessed. */
  servedModel: string | null;
  /** True only when the upstream named a model different from the requested one. */
  modelSubstituted: boolean;
  latencyMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** Present only on a tool-configured turn: the calls the model asked for. */
  toolCalls?: GatewayToolCall[];
  /** Present only on a tool-configured turn: how each call fared on the rung. */
  observations?: GatewayToolObservation[];
  /** Present only on a tool-configured turn: the assistant's raw content. */
  content?: string;
}

/**
 * The resolved execution rung for one turn: the `executeEffect` the shared
 * engine calls for each tool call. `synthetic` is the in-memory workspace;
 * `sandbox` escalates `process.exec` to Kubernetes/gVisor.
 */
export interface TurnRung {
  executeEffect(effect: Effect, minFidelity?: number): Promise<EffectResult>;
  /**
   * True when every effect (including workspace.read/write/list) executes inside
   * the trust boundary. The sandbox rung is isolated; the synthetic rung is not.
   * A scored run must refuse a rung that is not isolated.
   */
  isolated?: boolean;
  /** Sync the rung's workspace back to its checkpoint cache. */
  checkpoint?(): Promise<void>;
  /**
   * True when the rung holds a resource that must outlive one turn (a persistent
   * sandbox pod). `runTurn` then checkpoints instead of closing after each turn.
   */
  persistent?: boolean;
  /**
   * The receipt store the rung's broker uses. `runTurn` heartbeats it so its
   * details (and so the committed effect receipts) survive an activity retry.
   */
  runtimeState?: RuntimeStateStore;
  close?(): Promise<void>;
}

/**
 * Refuse a scored run on an unisolated rung. The gym's `runner:"local"` refusal
 * is the same rule; this extends it to any unscoped synthetic workspace.
 */
export function assertRungAllowedForScored(rung: TurnRung, scored: boolean): void {
  if (scored && rung.isolated !== true) {
    throw new Error("UNISOLATED_RUNG_REFUSED: a scored run requires an isolated (sandbox) rung");
  }
}

/** Resolves a serializable rung selection into a live rung for one turn. */
export type RungFactory = (
  config: Exclude<DurableRungConfig, { kind: "none" }>,
  input: RunTurnInput,
  runtimeState?: RuntimeStateStore,
) => TurnRung | Promise<TurnRung>;

export interface GatewayRunTurnOptions {
  /** Base URL of the gateway, without a trailing path (e.g. http://127.0.0.1:8787). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Per-request timeout. Reasoning models can take tens of seconds. Default 120s. */
  timeoutMs?: number;
  /** How often to heartbeat while waiting on the model. Default 10s. */
  heartbeatIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Overridable for tests; the default heartbeats the current Temporal activity. */
  heartbeat?: () => void;
  /** Called with one record per successful turn (in-process observers, e.g. a live driver). */
  onTurn?: (record: GatewayTurnRecord) => void;
  /**
   * The shared turn body. Defaults to `GatewayAgentEngine` configured for event
   * triage; tests inject one to observe that the activity really runs it.
   */
  engine?: AgentEngine;
  /**
   * Resolves the turn's serializable rung selection into a live execution rung.
   * Defaults to the synthetic/sandbox factory in this module; tests inject one
   * to observe executor calls.
   */
  rungFactory?: RungFactory;
  /**
   * Durable store for effect receipts. Defaults to the Temporal activity state
   * (`TemporalActivityStateStore.fromCurrentActivity()`), so a retried activity
   * starts with the committed receipts and dedupes by `effect.id`. Inject one
   * in unit tests; a direct (non-Temporal) caller can pass a store explicitly.
   */
  runtimeState?: RuntimeStateStore;
}

export const TRIAGE_SYSTEM_PROMPT = [
  "You triage a stream of events for an operations desk.",
  "Classify each event into exactly one class:",
  '- "news": factual reporting or an announcement from an institution or news outlet.',
  '- "social_post": an informal, personal post from an individual on social media.',
  '- "incident": an operational alert about a system failure or degradation that needs action.',
  "For each event also give a short reaction (at most 12 words) describing what the desk should do.",
  'Reply with ONLY a JSON object of the form {"events":[{"classification":"news|social_post|incident","reaction":"..."}]}',
  "containing exactly one entry per event, in the same order as the events were listed.",
  "No prose, no markdown, no code fences.",
].join("\n");

export function buildTriageUserMessage(messages: readonly DurableMailboxMessage[]): string {
  const lines = messages.map((message, index) => `${index + 1}. ${message.text}`);
  return `Classify these ${messages.length} event(s), in order:\n${lines.join("\n")}`;
}

/** Tolerates a model wrapping its JSON in a code fence or a line of prose. */
export function extractJsonObject(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
    throw new Error(`model reply is not JSON: ${stripped.slice(0, 200)}`);
  }
}

export function parseClassifications(text: string, expected: number): EventClassification[] {
  const parsed = extractJsonObject(text) as { events?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.events)) {
    throw new Error(`model reply has no "events" array: ${text.slice(0, 200)}`);
  }
  if (parsed.events.length !== expected) {
    throw new Error(`model returned ${parsed.events.length} classifications for ${expected} events`);
  }
  return parsed.events.map((entry, index) => {
    const item = entry as { classification?: unknown; reaction?: unknown };
    if (typeof item?.classification !== "string") {
      throw new Error(`event ${index + 1} has no string classification`);
    }
    return { classification: item.classification.trim().toLowerCase(), reaction: typeof item.reaction === "string" ? item.reaction : "" };
  });
}

function defaultHeartbeat(): void {
  try {
    ActivityContext.current().heartbeat();
  } catch {
    // Not inside an activity (unit tests): nothing to heartbeat.
  }
}

function currentAttempt(): number {
  try {
    return ActivityContext.current().info.attempt;
  } catch {
    return 1;
  }
}

function toAgentMessage(message: DurableMailboxMessage): AgentMessage {
  return { id: message.id, role: message.role, text: message.text, createdAt: message.createdAt };
}

function buildTurnContext(input: RunTurnInput, model: string, rung?: TurnRung): AgentEngineContext {
  const inferenceProfile = { id: model, model };
  return {
    agentId: input.agentId as AgentId,
    workspaceId: `temporal:${input.agentId}` as WorkspaceId,
    definition: { id: input.agentId, inferenceProfile },
    inferenceProfile,
    signal: new AbortController().signal,
    // The durable workflow owns observable state; the activity is pure compute.
    emitOutput: () => {},
    emitTool: () => {},
    // Without a configured rung the shared engine refuses every tool call
    // ("No effect executor configured") instead of silently dropping it.
    ...(rung
      ? {
          executeEffect: async (effect: Effect, minFidelity?: number) => {
            const started = Date.now();
            try {
              const result = await rung.executeEffect(effect, minFidelity);
              recordEffect(Date.now() - started, { kind: effect.kind, executor: result.executor ?? "unknown" });
              return result;
            } catch (error) {
              recordEffect(Date.now() - started, { kind: effect.kind, executor: "error" });
              throw error;
            }
          },
        }
      : {}),
  };
}

/** Map the serializable tool surface to the engine's `toEffect` hook. */
export function buildToEffect(tools: readonly DurableToolSpec[]): NonNullable<GatewayAgentEngineOptions["toEffect"]> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return (call, context, index) => {
    const spec = byName.get(call.name);
    if (!spec) return undefined;
    const arg = (name: string): string | undefined => {
      const value = call.arguments[name];
      if (value === undefined || value === null) return undefined;
      return typeof value === "string" ? value : String(value);
    };
    const id = `${context.agentId}:${call.name}:${index}`;
    switch (spec.effect) {
      case "workspace.read":
        return { id, kind: "workspace.read", path: arg(spec.pathArg ?? "path") ?? "" };
      case "workspace.write":
        return { id, kind: "workspace.write", path: arg(spec.pathArg ?? "path") ?? "", content: arg(spec.contentArg ?? "content") ?? "" };
      case "workspace.replace":
        return {
          id,
          kind: "workspace.replace",
          path: arg(spec.pathArg ?? "path") ?? "",
          oldText: arg(spec.oldTextArg ?? "old_text") ?? "",
          newText: arg(spec.newTextArg ?? "new_text") ?? "",
        };
      case "workspace.delete":
        return { id, kind: "workspace.delete", path: arg(spec.pathArg ?? "path") ?? "" };
      case "workspace.list": {
        const path = arg(spec.pathArg ?? "path");
        return path === undefined ? { id, kind: "workspace.list" } : { id, kind: "workspace.list", path };
      }
      case "process.exec": {
        // A fixed command (e.g. the gym's `run_visible_test`) is not taken from
        // the model's arguments; the tool name already implies the command.
        const command = spec.command ?? arg(spec.commandArg ?? "command") ?? "";
        const cwd = arg(spec.cwdArg ?? "cwd");
        const timeout = call.arguments[spec.timeoutArg ?? "timeoutMs"];
        return {
          id,
          kind: "process.exec",
          command,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(typeof timeout === "number" ? { timeoutMs: timeout } : {}),
          ...(spec.resourceClass ? { resourceClass: spec.resourceClass } : {}),
        };
      }
    }
  };
}

// Synthetic workspaces persist for the lifetime of the worker process, keyed by
// workspace id, so a multi-turn tool run sees its earlier writes. Durability
// across worker restarts is the materialization/checkpoint layer's job (the gym
// branch), not the cheap rung's.
const syntheticWorkspaces = new Map<string, MemoryWorkspace>();

function seedWorkspace(workspaceId: WorkspaceId, files?: Record<string, string>): MemoryWorkspace {
  let workspace = syntheticWorkspaces.get(workspaceId);
  if (!workspace) {
    workspace = new MemoryWorkspace({ id: workspaceId });
    for (const [path, content] of Object.entries(files ?? {})) workspace.write(path, content);
    syntheticWorkspaces.set(workspaceId, workspace);
  }
  return workspace;
}

// A sandbox rung holds a persistent pod for the workspace, so it outlives one
// turn; cache it per agent for the worker process's lifetime.
const sandboxRungs = new Map<string, TurnRung>();

async function sandboxRung(config: Exclude<DurableRungConfig, { kind: "none" }> & { kind: "sandbox" }, input: RunTurnInput, runtimeState?: RuntimeStateStore): Promise<TurnRung> {
  const key = `temporal:${input.agentId}`;
  const cached = sandboxRungs.get(key);
  if (cached) return cached;

  const image = config.image ?? EXECUTOR_IMAGE;
  const classes = DEFAULT_KUBERNETES_RESOURCE_CLASSES
    .filter((entry) => entry.id !== "project-cell")
    .map((entry) => ({ ...entry, image }));
  const backend = new KubectlSandboxBackend({
    namespace: config.namespace ?? "synth-sandboxes",
    ...(config.kubectlContext ? { context: config.kubectlContext } : {}),
  });
  const pool = new WarmSandboxPool(backend, classes);
  await pool.maintain();
  const workspaceId = `temporal:${input.agentId}` as WorkspaceId;
  const workspace = seedWorkspace(workspaceId, config.files);
  const workspaces = new Map<WorkspaceId, MemoryWorkspace>([[workspaceId, workspace]]);
  // No SyntheticExecutor: workspace.read/write/list must execute in the pod, not
  // in worker RAM. The pod is the medium; `workspace` is only the checkpoint cache.
  const executors = classes.map((resourceClass) => new SandboxWorkspaceExecutor({ resourceClass, backend, workspaces, pool }));
  const broker = new ExecutionBroker(executors, runtimeState);
  const rung: TurnRung = {
    isolated: true,
    persistent: true,
    ...(runtimeState ? { runtimeState } : {}),
    executeEffect: (effect, minFidelity) => broker.execute(
      effect,
      {
        agentId: input.agentId as AgentId,
        workspaceId,
        executionPolicy: { preferredClass: "sandbox-small", allowedClasses: classes.map((entry) => entry.id), allowEscalation: true },
      },
      minFidelity,
    ),
    checkpoint: async () => {
      for (const executor of executors) {
        if (executor.hasSandbox(workspaceId)) { await executor.checkpoint(workspaceId); return; }
      }
    },
    close: async () => {
      sandboxRungs.delete(key);
      for (const executor of executors) await executor.close();
      await pool.close();
    },
  };
  sandboxRungs.set(key, rung);
  return rung;
}

/** Destroy every cached sandbox rung (worker shutdown, or between tests). */
export async function closeSandboxRungs(): Promise<void> {
  for (const rung of [...sandboxRungs.values()]) await rung.close?.();
}

/** Default rung factory: serializable config -> live synthetic/sandbox rung. */
export const defaultRungFactory: RungFactory = (config, input, runtimeState) => {
  if (config.kind === "synthetic") {
    const workspaceId = (config.workspaceId ?? `temporal:${input.agentId}`) as WorkspaceId;
    const workspace = seedWorkspace(workspaceId, config.files);
    const workspaces = new Map<WorkspaceId, MemoryWorkspace>([[workspaceId, workspace]]);
    const broker = new ExecutionBroker([new SyntheticExecutor(workspaces)], runtimeState);
    return {
      // Explicitly unisolated: workspace effects run in worker RAM.
      isolated: false,
      ...(runtimeState ? { runtimeState } : {}),
      executeEffect: (effect, minFidelity) => broker.execute(effect, { agentId: input.agentId as AgentId, workspaceId }, minFidelity),
    };
  }
  return sandboxRung(config, input, runtimeState);
};

/** Translate the shared body's status-carrying error into Temporal's retry taxonomy. */
function toTemporalError(error: unknown): unknown {
  if (error instanceof GatewayHttpError) {
    if (PERMANENT_HTTP_STATUSES.has(error.status)) {
      return ApplicationFailure.nonRetryable(error.message, `GatewayHTTP${error.status}`);
    }
    if (error.retryAfterMs !== undefined && (error.status === 429 || error.status === 503)) {
      // Carry the server's reset hint across the activity boundary so the
      // workflow waits for the real window instead of a blind backoff.
      return ApplicationFailure.create({ message: error.message, type: "RateLimited", details: [{ retryAfterMs: error.retryAfterMs }] });
    }
  }
  return error;
}

export function createGatewayRunTurn(options: GatewayRunTurnOptions): AgentActivities["runTurn"] {
  return async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const config = input.config ?? {};
    const toolMode = (config.tools?.length ?? 0) > 0;
    try {
      // Correlated log line: the activity interceptor adds workflowId/runId/
      // activityId/agentId/rung to the activity logger's attributes.
      ActivityContext.current().log.info("synth.turn.start", { messages: input.messages.length, toolMode, rung: config.rung?.kind ?? "none" });
    } catch {
      // Not inside an activity (unit tests): no logger to write to.
    }

    // Effect receipts are durable Temporal activity state by default: a retry
    // re-reads the previous attempt's committed receipts from the heartbeat
    // details, so a committed effect is not executed twice.
    const runtimeState = options.runtimeState ?? TemporalActivityStateStore.fromCurrentActivity();

    // Resolve the turn's execution rung from the serializable selection. No rung
    // (or `none`) leaves `executeEffect` unset, so the shared engine refuses
    // tool calls rather than dropping them.
    let rung: TurnRung | undefined;
    if (config.rung && config.rung.kind !== "none") {
      rung = await (options.rungFactory ?? defaultRungFactory)(config.rung, input, runtimeState);
      // A scored turn must run inside a trust boundary. Refuse an unisolated
      // rung before the model is called, so a scored run can never execute
      // model-authored effects in worker RAM.
      assertRungAllowedForScored(rung, config.scored === true);
    }

    // While the engine waits on the model it heartbeats; each heartbeat must
    // carry the rung's receipt details, or it would erase the receipts the
    // broker persisted and defeat the dedupe.
    const receiptStore = rung?.runtimeState ?? runtimeState;
    const heartbeat = options.heartbeat
      ?? (receiptStore instanceof TemporalActivityStateStore ? () => receiptStore.heartbeat() : defaultHeartbeat);

    // The one turn body. Configured per turn from the carried config; a
    // tool-configured turn returns observations, the triage turn classifications.
    const engine = options.engine ?? createGatewayAgentEngine({
      baseUrl: options.baseUrl,
      model: options.model,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      heartbeat,
      systemPrompt: config.systemPrompt ?? TRIAGE_SYSTEM_PROMPT,
      buildUserMessage: config.systemPrompt
        ? (messages) => messages.map((message) => message.text).join("\n")
        : (messages) => buildTriageUserMessage(messages),
      ...(config.tools ? { toEffect: buildToEffect(config.tools) } : {}),
    });

    const messages = input.messages.map(toAgentMessage);
    let outcome: GatewayTurnOutcome;
    const modelStartedAt = Date.now();
    try {
      outcome = (await engine.run(messages, buildTurnContext(input, options.model, rung))) as GatewayTurnOutcome;
    } catch (error) {
      throw toTemporalError(error);
    } finally {
      // One turn body run == one model call; count and time it with the model
      // and rung tags (the SDK's own metrics cover workflow/activity latency).
      recordModelCall(Date.now() - modelStartedAt, { model: options.model, rung: config.rung?.kind ?? "none" });
      // A persistent rung (sandbox pod) outlives the turn: checkpoint it so the
      // cache reflects the pod, but do not destroy it. A one-shot rung closes.
      if (rung?.persistent) await rung.checkpoint?.().catch(() => {});
      else await rung?.close?.();
    }

    const classifications = toolMode ? [] : parseClassifications(outcome.content, input.messages.length);
    const record: GatewayTurnRecord = {
      agentId: input.agentId,
      attempt: currentAttempt(),
      plantedKinds: input.messages.map((message) => message.kind ?? null),
      classifications,
      requestedModel: outcome.requestedModel ?? options.model,
      // The upstream is the only authority on which model answered. If it omits
      // the field we record `null` (unknown) rather than back-filling the
      // requested id, which would hide a router substitution.
      servedModel: outcome.servedModel ?? null,
      modelSubstituted: outcome.modelSubstituted ?? false,
      latencyMs: outcome.latencyMs ?? 0,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      ...(toolMode ? { toolCalls: outcome.toolCalls, observations: outcome.observations, content: outcome.content } : {}),
    };
    options.onTurn?.(record);
    return toolMode
      ? { result: { content: outcome.content, toolCalls: outcome.toolCalls, observations: outcome.observations, latencyMs: record.latencyMs }, state: "idle" }
      : { result: { classifications, latencyMs: record.latencyMs }, state: "idle" };
  };
}
