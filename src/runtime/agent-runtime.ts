import { randomUUID } from "node:crypto";
import { newAgentId, newTaskId, type AgentId, type TaskId, type WorkspaceId } from "../core/ids.js";
import type { AgentDefinition, AgentMessage, AgentSnapshot, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import { isAgentFenceRejected, persistAgentSnapshot, type AgentWriteFence, type DurabilityProvider } from "../durability/types.js";
import type { RuntimeStateStore } from "../durability/runtime-state.js";
import type { MailboxStore, MailboxEnvelope } from "../control-plane/mailbox.js";
import { ExecutionBroker } from "../execution/broker.js";
import type { Effect, EffectResult } from "../execution/types.js";
import { MemoryWorkspace } from "../workspace/memory-workspace.js";
import { deserializeWorkspaceSnapshot, serializeWorkspaceSnapshot } from "../workspace/snapshot-codec.js";
import type { AgentEngine } from "./agent-engine.js";

type Listener = (event: RuntimeEvent) => void;

interface LiveAgent {
  snapshot: AgentSnapshot;
  definition: AgentDefinition;
  engine: AgentEngine;
  abort?: AbortController;
  run?: Promise<unknown>;
  activeFence?: AgentWriteFence;
}

export interface AgentRunOptions {
  fence?: AgentWriteFence;
}

export interface AgentRecoveryOptions {
  definition(definitionId: string, snapshot: AgentSnapshot): Promise<AgentDefinition> | AgentDefinition;
  engine(definition: AgentDefinition, snapshot: AgentSnapshot): Promise<AgentEngine> | AgentEngine;
  workspace?(snapshot: AgentSnapshot): Promise<MemoryWorkspace> | MemoryWorkspace;
  /** Non-terminal in-flight states cannot safely resume an arbitrary JS stack. Default: idle. */
  recoveredState?: AgentSnapshot["state"];
  /** Optional ownership proof for recovery writes in distributed deployments. */
  fence?(snapshot: AgentSnapshot): Promise<AgentWriteFence | undefined> | AgentWriteFence | undefined;
}

export interface RecoverResult {
  agents: number;
  workspaces: number;
  incompleteTurnsRolledBack: number;
  incompleteTurnsFailed: number;
}

export class AgentRuntime {
  readonly workspaces: Map<WorkspaceId, MemoryWorkspace>;
  readonly #agents = new Map<AgentId, LiveAgent>();
  readonly #listeners = new Set<Listener>();
  #eventTail: Promise<void> = Promise.resolve();
  #eventError?: unknown;

  constructor(
    private readonly durability: DurabilityProvider,
    private readonly executionBroker?: ExecutionBroker,
    workspaces: Map<WorkspaceId, MemoryWorkspace> = new Map(),
    private readonly runtimeState?: RuntimeStateStore,
    private readonly mailboxStore?: MailboxStore,
  ) {
    this.workspaces = workspaces;
  }

  async createWorkspace(workspace = new MemoryWorkspace()): Promise<MemoryWorkspace> {
    this.workspaces.set(workspace.id, workspace);
    await this.checkpointWorkspace(workspace.id, "workspace.created");
    return workspace;
  }

  async createTask(input: Omit<TaskSpec, "id" | "status"> & { id?: TaskId; status?: TaskSpec["status"] }): Promise<TaskSpec> {
    const task: TaskSpec = { ...input, id: input.id ?? newTaskId(), status: input.status ?? "pending" };
    await this.durability.putTask(task);
    await this.#emit({ type: "task.updated", task });
    return task;
  }

  async spawn(options: {
    definition: AgentDefinition;
    engine: AgentEngine;
    workspace: MemoryWorkspace;
    task?: TaskSpec;
    metadata?: Record<string, unknown>;
    id?: AgentId;
  }): Promise<AgentSnapshot> {
    const now = Date.now();
    const id = options.id ?? newAgentId();
    if (this.#agents.has(id)) throw new Error(`AGENT_ALREADY_EXISTS:${id}`);
    const snapshot: AgentSnapshot = {
      id,
      definitionId: options.definition.id,
      taskId: options.task?.id,
      workspaceId: options.workspace.id,
      state: "idle",
      createdAt: now,
      updatedAt: now,
      mailbox: [],
      metadata: options.metadata ?? {},
    };
    if (!(await this.durability.createAgent(snapshot))) throw new Error(`AGENT_ALREADY_EXISTS:${id}`);
    // Re-check the live map after the durability boundary: another concurrent
    // local spawn may have won while createAgent was in flight. The durable
    // identity remains authoritative, so never replace an existing live agent.
    if (this.#agents.has(id)) throw new Error(`AGENT_ALREADY_EXISTS:${id}`);
    this.workspaces.set(options.workspace.id, options.workspace);
    this.#agents.set(snapshot.id, { snapshot, definition: options.definition, engine: options.engine });
    if (options.task) {
      const task = { ...options.task, owner: snapshot.id, status: "running" as const };
      await this.durability.putTask(task);
      await this.#emit({ type: "task.updated", task });
    }
    await this.checkpointWorkspace(snapshot.workspaceId, "agent.spawn");
    await this.#emit({ type: "agent.created", agent: snapshot });
    return structuredClone(snapshot);
  }

  /**
   * Rebuilds logical agents after control-plane restart. Arbitrary JS call stacks
   * are not resumed; non-terminal active states are normalized to `recoveredState`
   * and the durable mailbox/task/world remains available for a fresh engine turn.
   */
  async recover(options: AgentRecoveryOptions): Promise<RecoverResult> {
    let workspaceCount = 0;
    let agentCount = 0;
    let rolledBack = 0;
    let failedTurns = 0;

    if (this.runtimeState) {
      for (const turn of await this.runtimeState.listTurns("started")) {
        let workspace = this.workspaces.get(turn.workspaceId);
        if (!workspace) {
          const owner = (await this.durability.listAgents()).find((agent) => agent.workspaceId === turn.workspaceId);
          if (owner && options.workspace) workspace = await options.workspace(owner);
          if (!workspace) workspace = new MemoryWorkspace({ id: turn.workspaceId });
          this.workspaces.set(turn.workspaceId, workspace);
          workspaceCount++;
        }
        workspace.restore(deserializeWorkspaceSnapshot(turn.base));
        await this.runtimeState.putWorkspaceCheckpoint({
          workspaceId: workspace.id,
          snapshot: turn.base,
          reason: `recover.turn.${turn.id}`,
          createdAt: Date.now(),
        });
        const crossedBoundary = turn.semanticExposed;
        await this.runtimeState.putTurn({
          ...turn,
          status: crossedBoundary ? "failed" : "rolled_back",
          error: crossedBoundary
            ? "Recovered after process interruption following semantic exposure; reconciliation required"
            : "Recovered after process interruption",
          updatedAt: Date.now(),
        });
        if (crossedBoundary) failedTurns++;
        else rolledBack++;
      }
    }

    for (const durableSnapshot of await this.durability.listAgents()) {
      if (this.#agents.has(durableSnapshot.id)) continue;
      let workspace = this.workspaces.get(durableSnapshot.workspaceId);
      if (!workspace) {
        workspace = options.workspace ? await options.workspace(durableSnapshot) : new MemoryWorkspace({ id: durableSnapshot.workspaceId });
        const checkpoint = await this.runtimeState?.getWorkspaceCheckpoint(durableSnapshot.workspaceId);
        if (checkpoint) workspace.restore(deserializeWorkspaceSnapshot(checkpoint.snapshot));
        this.workspaces.set(workspace.id, workspace);
        workspaceCount++;
      }

      const definition = await options.definition(durableSnapshot.definitionId, durableSnapshot);
      const engine = await options.engine(definition, durableSnapshot);
      const snapshot = structuredClone(durableSnapshot);
      const wasActive = isInFlight(snapshot.state);
      if (wasActive) {
        const from = snapshot.state;
        snapshot.state = options.recoveredState ?? "idle";
        snapshot.updatedAt = Date.now();
        snapshot.metadata = { ...snapshot.metadata, recoveredAt: snapshot.updatedAt, recoveredFromState: from };
        const fence = await options.fence?.(snapshot);
        await persistAgentSnapshot(this.durability, snapshot, fence);
      }
      this.#agents.set(snapshot.id, { snapshot, definition, engine });
      agentCount++;
      await this.#emit({ type: "agent.recovered", agent: snapshot, previousState: durableSnapshot.state, at: Date.now() });
    }

    return { agents: agentCount, workspaces: workspaceCount, incompleteTurnsRolledBack: rolledBack, incompleteTurnsFailed: failedTurns };
  }

  async checkpointWorkspace(workspaceId: WorkspaceId, reason = "runtime.checkpoint"): Promise<void> {
    if (!this.runtimeState) return;
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`);
    await this.runtimeState.putWorkspaceCheckpoint({
      workspaceId,
      snapshot: serializeWorkspaceSnapshot(await workspace.snapshot()),
      reason,
      createdAt: Date.now(),
    });
  }

  /**
   * At-most-once logical command helper for retries from RPC/Temporal.
   *
   * By default, an exception leaves the command `started`/uncertain because the
   * callback may have crossed an external side-effect boundary before throwing.
   * Callers may opt into `retrySafeOnError` only when the command is known to be
   * replay-safe after an exception.
   */
  async command<T>(
    id: string,
    run: () => Promise<T>,
    options: { retrySafeOnError?: boolean } = {},
  ): Promise<T> {
    if (!this.runtimeState) return run();
    const existing = await this.runtimeState.getCommand(id);
    if (existing?.status === "committed") return structuredClone(existing.result) as T;
    if (existing?.status === "started") {
      const uncertain = existing.error?.startsWith("uncertain:");
      throw new Error(uncertain ? `COMMAND_OUTCOME_UNCERTAIN:${id}` : `Command ${id} is already in progress`);
    }
    const now = Date.now();
    const started = { id, status: "started" as const, startedAt: now, updatedAt: now };
    if (this.runtimeState.claimCommand) {
      const claim = await this.runtimeState.claimCommand(started);
      if (!claim.claimed) {
        if (claim.record.status === "committed") return structuredClone(claim.record.result) as T;
        if (claim.record.status === "started") {
          const uncertain = claim.record.error?.startsWith("uncertain:");
          throw new Error(uncertain ? `COMMAND_OUTCOME_UNCERTAIN:${id}` : `Command ${id} is already in progress`);
        }
      }
    } else {
      await this.runtimeState.putCommand(started);
    }
    try {
      const result = await run();
      await this.runtimeState.putCommand({ id, status: "committed", startedAt: now, updatedAt: Date.now(), result });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.runtimeState.putCommand({
        id,
        status: options.retrySafeOnError ? "failed" : "started",
        startedAt: now,
        updatedAt: Date.now(),
        error: options.retrySafeOnError ? detail : `uncertain:${detail}`,
      });
      throw error;
    }
  }

  async addRelation(relation: Relation): Promise<void> {
    await this.durability.putRelation(relation);
    await this.#emit({ type: "relation.added", relation });
  }

  attach(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(
    agentId: AgentId,
    text: string,
    role: AgentMessage["role"] = "human",
    metadata?: Record<string, unknown>,
    messageId = randomUUID(),
  ): Promise<AgentMessage> {
    const agent = this.#require(agentId);
    const existing = agent.snapshot.mailbox.find((item) => item.id === messageId);
    if (existing) return structuredClone(existing);
    const message: AgentMessage = { id: messageId, role, text, createdAt: Date.now(), metadata };
    if (this.mailboxStore) {
      const append = await this.mailboxStore.appendMailbox(agentId, message);
      if (!append.inserted) return structuredClone(append.envelope.message);
    } else {
      // Yield-free from the duplicate check through insertion so same-runtime
      // concurrent sends cannot both claim the same caller-supplied id.
      const raced = agent.snapshot.mailbox.find((item) => item.id === message.id);
      if (raced) return structuredClone(raced);
    }
    agent.snapshot.mailbox.push(message);
    agent.snapshot.updatedAt = Date.now();
    // With a dedicated durable mailbox, message delivery is authoritative there
    // and must not race a fenced agent-state writer. Single-store mode persists
    // the mailbox inside the agent snapshot as before.
    if (!this.mailboxStore) await this.#persistAgent(agent);
    await this.#emit({ type: "agent.message", agentId, message });
    await agent.engine.steer?.(message);
    return message;
  }

  async executeEffect(agentId: AgentId, effect: Effect, minFidelity = 0): Promise<EffectResult> {
    if (!this.executionBroker) return { ok: false, error: "No execution broker configured" };
    const agent = this.#require(agentId);
    const result = await this.executionBroker.execute(
      effect,
      {
        agentId,
        taskId: agent.snapshot.taskId,
        workspaceId: agent.snapshot.workspaceId,
        executionPolicy: agent.definition.executionPolicy,
      },
      minFidelity,
    );
    if (result.ok) await this.checkpointWorkspace(agent.snapshot.workspaceId, `effect.${effect.kind}`);
    return result;
  }

  async run(agentId: AgentId, options: AgentRunOptions = {}): Promise<unknown> {
    const agent = this.#require(agentId);
    if (agent.run) {
      if (options.fence && !sameFence(agent.activeFence, options.fence)) {
        throw new Error(`AGENT_RUN_FENCE_CONFLICT:${agentId}`);
      }
      return agent.run;
    }
    agent.activeFence = options.fence;
    const controller = new AbortController();
    agent.abort = controller;
    const promise = (async () => {
      await this.checkpointWorkspace(agent.snapshot.workspaceId, "agent.run.begin");
      await this.#setState(agent, "thinking");
      try {
        const mailboxBatch = await this.#mailboxBatch(agentId, agent.snapshot.mailbox);
        const result = await agent.engine.run(mailboxBatch.messages, {
          agentId,
          taskId: agent.snapshot.taskId,
          workspaceId: agent.snapshot.workspaceId,
          definition: agent.definition,
          inferenceProfile: agent.definition.inferenceProfile,
          signal: controller.signal,
          emitOutput: (text) => this.#scheduleEvent({ type: "agent.output", agentId, text, at: Date.now() }),
          emitTool: (name, phase, data) => this.#scheduleEvent({ type: "agent.tool", agentId, name, phase, data, at: Date.now() }),
          executeEffect: this.executionBroker
            ? (effect, minFidelity) => this.executeEffect(agentId, effect, minFidelity)
            : undefined,
        });
        await this.#flushEvents();
        await this.checkpointWorkspace(agent.snapshot.workspaceId, "agent.run.commit");
        await this.#setState(agent, "completed");
        await this.#emit({ type: "agent.completed", agentId, result, at: Date.now() });
        if (mailboxBatch.ackSeq !== undefined) await this.mailboxStore?.ackMailbox(agentId, "engine", mailboxBatch.ackSeq);
        return result;
      } catch (error) {
        // A stale owner must stop immediately. In particular, it must not emit a
        // new durable failure state/event after a higher fencing generation won.
        if (isAgentFenceRejected(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        await this.checkpointWorkspace(agent.snapshot.workspaceId, "agent.run.error");
        try {
          await this.#setState(agent, controller.signal.aborted ? "cancelled" : "failed");
        } catch (stateError) {
          if (isAgentFenceRejected(stateError)) throw stateError;
          throw stateError;
        }
        await this.#emit({ type: "agent.failed", agentId, error: message, at: Date.now() });
        throw error;
      } finally {
        agent.run = undefined;
        agent.abort = undefined;
        agent.activeFence = undefined;
      }
    })();
    agent.run = promise;
    return promise;
  }

  cancel(agentId: AgentId): void { this.#require(agentId).abort?.abort(); }

  get(agentId: AgentId): AgentSnapshot { return structuredClone(this.#require(agentId).snapshot); }

  async forkAgent(parentId: AgentId, engine: AgentEngine, task?: TaskSpec): Promise<AgentSnapshot> {
    const parent = this.#require(parentId);
    const workspace = this.workspaces.get(parent.snapshot.workspaceId);
    if (!workspace) throw new Error(`Workspace missing for ${parentId}`);
    return this.spawn({
      definition: parent.definition,
      engine,
      workspace: workspace.fork(),
      task,
      metadata: { forkedFrom: parentId },
    });
  }


  async readMailbox(agentId: AgentId, consumerId = "client", limit = 1000): Promise<MailboxEnvelope[]> {
    if (!this.mailboxStore) return this.get(agentId).mailbox.map((message, index) => ({ agentId, seq: index + 1, message, appendedAt: message.createdAt }));
    const cursor = await this.mailboxStore.getMailboxCursor(agentId, consumerId);
    return this.mailboxStore.readMailbox(agentId, cursor?.ackSeq ?? 0, limit);
  }

  async ackMailbox(agentId: AgentId, consumerId: string, throughSeq: number): Promise<void> {
    if (!this.mailboxStore) return;
    await this.mailboxStore.ackMailbox(agentId, consumerId, throughSeq);
  }

  async #mailboxBatch(agentId: AgentId, fallback: AgentMessage[]): Promise<{ messages: AgentMessage[]; ackSeq?: number }> {
    if (!this.mailboxStore) return { messages: fallback.map((message) => structuredClone(message)) };
    const cursor = await this.mailboxStore.getMailboxCursor(agentId, "engine");
    const envelopes = await this.mailboxStore.readMailbox(agentId, cursor?.ackSeq ?? 0, 10_000);
    if (envelopes.length === 0 && cursor === undefined) return { messages: fallback.map((message) => structuredClone(message)) };
    return { messages: envelopes.map((item) => structuredClone(item.message)), ackSeq: envelopes.at(-1)?.seq };
  }

  async #setState(agent: LiveAgent, to: AgentSnapshot["state"]): Promise<void> {
    const from = agent.snapshot.state;
    if (from === to) return;
    const previousUpdatedAt = agent.snapshot.updatedAt;
    agent.snapshot.state = to;
    agent.snapshot.updatedAt = Date.now();
    try {
      await this.#persistAgent(agent);
    } catch (error) {
      agent.snapshot.state = from;
      agent.snapshot.updatedAt = previousUpdatedAt;
      throw error;
    }
    await this.#emit({ type: "agent.state", agentId: agent.snapshot.id, from, to, at: Date.now() });
  }

  async #persistAgent(agent: LiveAgent): Promise<void> {
    await persistAgentSnapshot(this.durability, agent.snapshot, agent.activeFence);
  }

  #require(id: AgentId): LiveAgent {
    const agent = this.#agents.get(id);
    if (!agent) throw new Error(`Unknown agent ${id}`);
    return agent;
  }

  async #emit(event: RuntimeEvent): Promise<void> {
    this.#scheduleEvent(event);
    await this.#flushEvents();
  }

  #scheduleEvent(event: RuntimeEvent): void {
    const snapshot = structuredClone(event);
    this.#eventTail = this.#eventTail.then(async () => {
      if (this.#eventError !== undefined) return;
      try {
        await this.durability.appendEvent(snapshot);
        // Observers must not be able to corrupt the durable runtime by throwing.
        for (const listener of this.#listeners) {
          try { listener(structuredClone(snapshot)); } catch { /* observer isolation */ }
        }
      } catch (error) {
        this.#eventError = error;
      }
    });
  }

  async #flushEvents(): Promise<void> {
    await this.#eventTail;
    if (this.#eventError !== undefined) throw this.#eventError;
  }
}

function isInFlight(state: AgentSnapshot["state"]): boolean {
  return state !== "idle" && state !== "completed" && state !== "failed" && state !== "cancelled";
}

function sameFence(a: AgentWriteFence | undefined, b: AgentWriteFence | undefined): boolean {
  return a?.resourceId === b?.resourceId && a?.ownerId === b?.ownerId && a?.fencingToken === b?.fencingToken;
}
