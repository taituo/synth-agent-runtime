import type { AgentId } from "../core/ids.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { LeaseStore } from "./lease.js";
/** Serializes one logical agent run across control-plane replicas. */
export declare class LeasedAgentRunner {
    private readonly runtime;
    private readonly leases;
    private readonly ownerId;
    private readonly ttlMs;
    constructor(runtime: AgentRuntime, leases: LeaseStore, ownerId: string, ttlMs?: number);
    run(agentId: AgentId): Promise<unknown>;
}
