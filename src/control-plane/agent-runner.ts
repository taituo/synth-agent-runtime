import type { AgentId } from "../core/ids.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { LeaseStore } from "./lease.js";
import { withRenewingLease } from "./lease.js";

/** Serializes one logical agent run across control-plane replicas. */
export class LeasedAgentRunner {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly leases: LeaseStore,
    private readonly ownerId: string,
    private readonly ttlMs = 30_000,
  ) {}

  async run(agentId: AgentId): Promise<unknown> {
    return withRenewingLease({
      store: this.leases,
      resourceId: `agent:${agentId}`,
      ownerId: this.ownerId,
      ttlMs: this.ttlMs,
      run: async (lease, signal) => {
        const onAbort = () => this.runtime.cancel(agentId);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await this.runtime.run(agentId, {
            fence: {
              resourceId: lease.resourceId,
              ownerId: lease.ownerId,
              fencingToken: lease.fencingToken,
            },
          });
          if (signal.aborted) throw signal.reason ?? new Error(`LEASE_LOST:agent:${agentId}`);
          return result;
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
    });
  }
}
