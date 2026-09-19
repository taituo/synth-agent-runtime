import type { AgentId, ProjectId } from "../core/ids.js";
import type { Relation, TaskSpec } from "../core/types.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { AgentEngine } from "../runtime/agent-engine.js";
import type { InMemoryWorldStore } from "../world/in-memory-world.js";

export interface DelegatedAgent {
  task: TaskSpec;
  agentId: AgentId;
}

/**
 * Thin orchestration layer above AgentRuntime. It owns graph operations, not
 * inference or execution. The same child may later supervise more children.
 */
export class Supervisor {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly world?: InMemoryWorldStore,
  ) {}

  async delegate(options: {
    supervisorId: AgentId;
    title: string;
    objective: string;
    engine: AgentEngine;
    projectId?: ProjectId;
    constraints?: string[];
    dependencies?: TaskSpec["dependencies"];
    metadata?: Record<string, unknown>;
    autoRun?: boolean;
  }): Promise<DelegatedAgent> {
    const task = await this.runtime.createTask({
      title: options.title,
      objective: options.objective,
      constraints: options.constraints,
      dependencies: options.dependencies,
      metadata: options.metadata,
    });
    if (options.projectId && this.world) await this.world.attachTask(options.projectId, task);

    const child = await this.runtime.forkAgent(options.supervisorId, options.engine, task);
    await this.runtime.addRelation({ from: options.supervisorId, to: child.id, kind: "supervises" });
    await this.runtime.addRelation({ from: options.supervisorId, to: child.id, kind: "delegates_to", metadata: { taskId: task.id } });
    if (options.autoRun !== false) void this.runtime.run(child.id).catch(() => {});
    return { task, agentId: child.id };
  }

  async fanOut(options: {
    supervisorId: AgentId;
    projectId?: ProjectId;
    tasks: Array<{
      title: string;
      objective: string;
      constraints?: string[];
      metadata?: Record<string, unknown>;
    }>;
    engineFactory(task: { title: string; objective: string }, index: number): AgentEngine;
    autoRun?: boolean;
  }): Promise<DelegatedAgent[]> {
    const results: DelegatedAgent[] = [];
    for (const [index, task] of options.tasks.entries()) {
      results.push(await this.delegate({
        supervisorId: options.supervisorId,
        projectId: options.projectId,
        title: task.title,
        objective: task.objective,
        constraints: task.constraints,
        metadata: task.metadata,
        engine: options.engineFactory(task, index),
        autoRun: options.autoRun,
      }));
    }
    return results;
  }

  async assignReviewer(options: {
    supervisorId: AgentId;
    candidateAgentId: AgentId;
    reviewerEngine: AgentEngine;
    title?: string;
    objective?: string;
    projectId?: ProjectId;
  }): Promise<DelegatedAgent> {
    const review = await this.delegate({
      supervisorId: options.supervisorId,
      projectId: options.projectId,
      title: options.title ?? `Review ${options.candidateAgentId}`,
      objective: options.objective ?? `Review the candidate work produced by ${options.candidateAgentId}.`,
      engine: options.reviewerEngine,
      autoRun: false,
      metadata: { candidateAgentId: options.candidateAgentId },
    });
    const relation: Relation = { from: review.agentId, to: options.candidateAgentId, kind: "reviews" };
    await this.runtime.addRelation(relation);
    return review;
  }
}
