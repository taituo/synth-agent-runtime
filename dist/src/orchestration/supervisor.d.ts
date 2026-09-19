import type { AgentId, ProjectId } from "../core/ids.js";
import type { TaskSpec } from "../core/types.js";
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
export declare class Supervisor {
    private readonly runtime;
    private readonly world?;
    constructor(runtime: AgentRuntime, world?: InMemoryWorldStore | undefined);
    delegate(options: {
        supervisorId: AgentId;
        title: string;
        objective: string;
        engine: AgentEngine;
        projectId?: ProjectId;
        constraints?: string[];
        dependencies?: TaskSpec["dependencies"];
        metadata?: Record<string, unknown>;
        autoRun?: boolean;
    }): Promise<DelegatedAgent>;
    fanOut(options: {
        supervisorId: AgentId;
        projectId?: ProjectId;
        tasks: Array<{
            title: string;
            objective: string;
            constraints?: string[];
            metadata?: Record<string, unknown>;
        }>;
        engineFactory(task: {
            title: string;
            objective: string;
        }, index: number): AgentEngine;
        autoRun?: boolean;
    }): Promise<DelegatedAgent[]>;
    assignReviewer(options: {
        supervisorId: AgentId;
        candidateAgentId: AgentId;
        reviewerEngine: AgentEngine;
        title?: string;
        objective?: string;
        projectId?: ProjectId;
    }): Promise<DelegatedAgent>;
}
