import { withRenewingLease } from "./lease.js";
/** Serializes one logical agent run across control-plane replicas. */
export class LeasedAgentRunner {
    runtime;
    leases;
    ownerId;
    ttlMs;
    constructor(runtime, leases, ownerId, ttlMs = 30_000) {
        this.runtime = runtime;
        this.leases = leases;
        this.ownerId = ownerId;
        this.ttlMs = ttlMs;
    }
    async run(agentId) {
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
                    if (signal.aborted)
                        throw signal.reason ?? new Error(`LEASE_LOST:agent:${agentId}`);
                    return result;
                }
                finally {
                    signal.removeEventListener("abort", onAbort);
                }
            },
        });
    }
}
