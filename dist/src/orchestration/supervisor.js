/**
 * Thin orchestration layer above AgentRuntime. It owns graph operations, not
 * inference or execution. The same child may later supervise more children.
 */
export class Supervisor {
    runtime;
    world;
    constructor(runtime, world) {
        this.runtime = runtime;
        this.world = world;
    }
    async delegate(options) {
        const task = await this.runtime.createTask({
            title: options.title,
            objective: options.objective,
            constraints: options.constraints,
            dependencies: options.dependencies,
            metadata: options.metadata,
        });
        if (options.projectId && this.world)
            await this.world.attachTask(options.projectId, task);
        const child = await this.runtime.forkAgent(options.supervisorId, options.engine, task);
        await this.runtime.addRelation({ from: options.supervisorId, to: child.id, kind: "supervises" });
        await this.runtime.addRelation({ from: options.supervisorId, to: child.id, kind: "delegates_to", metadata: { taskId: task.id } });
        if (options.autoRun !== false)
            void this.runtime.run(child.id).catch(() => { });
        return { task, agentId: child.id };
    }
    async fanOut(options) {
        const results = [];
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
    async assignReviewer(options) {
        const review = await this.delegate({
            supervisorId: options.supervisorId,
            projectId: options.projectId,
            title: options.title ?? `Review ${options.candidateAgentId}`,
            objective: options.objective ?? `Review the candidate work produced by ${options.candidateAgentId}.`,
            engine: options.reviewerEngine,
            autoRun: false,
            metadata: { candidateAgentId: options.candidateAgentId },
        });
        const relation = { from: review.agentId, to: options.candidateAgentId, kind: "reviews" };
        await this.runtime.addRelation(relation);
        return review;
    }
}
