import type { RuntimeStateStore, DurableCommandRecord } from "../durability/runtime-state.js";
import type { LeaseStore } from "./lease.js";
import { withRenewingLease } from "./lease.js";

export type CommandReconciliation<T> =
  | { status: "committed"; result: T }
  | { status: "retry" }
  | { status: "failed"; error: string }
  | { status: "unknown"; detail?: string };

/**
 * Distributed command coordinator. A command lease serializes ownership and the
 * monotonic fencing token identifies the winning generation. An abandoned
 * `started` record is never replayed without explicit reconciliation.
 */
export class CommandCoordinator {
  constructor(
    private readonly state: RuntimeStateStore,
    private readonly leases: LeaseStore,
    private readonly ownerId: string,
    private readonly ttlMs = 30_000,
  ) {}

  async run<T>(options: {
    id: string;
    run(signal: AbortSignal, fencingToken: number): Promise<T>;
    retrySafeOnError?: boolean;
    reconcile?(record: DurableCommandRecord): Promise<CommandReconciliation<T>>;
  }): Promise<T> {
    return withRenewingLease({
      store: this.leases,
      resourceId: `command:${options.id}`,
      ownerId: this.ownerId,
      ttlMs: this.ttlMs,
      run: async (lease, signal) => {
        const existing = await this.state.getCommand(options.id);
        if (existing?.status === "committed") return structuredClone(existing.result) as T;
        if (existing?.status === "started") {
          if (!options.reconcile) throw new Error(`COMMAND_RECONCILIATION_REQUIRED:${options.id}`);
          const resolution = await options.reconcile(existing);
          if (resolution.status === "committed") {
            await this.state.putCommand({
              ...existing,
              status: "committed",
              result: resolution.result,
              error: undefined,
              ownerId: this.ownerId,
              fencingToken: lease.fencingToken,
              leaseExpiresAt: lease.expiresAt,
              reconciliationRequired: false,
              updatedAt: Date.now(),
            });
            return resolution.result;
          }
          if (resolution.status === "failed") {
            await this.state.putCommand({
              ...existing,
              status: "failed",
              error: resolution.error,
              ownerId: this.ownerId,
              fencingToken: lease.fencingToken,
              leaseExpiresAt: lease.expiresAt,
              reconciliationRequired: false,
              updatedAt: Date.now(),
            });
            throw new Error(resolution.error);
          }
          if (resolution.status === "unknown") throw new Error(`COMMAND_RECONCILIATION_REQUIRED:${options.id}:${resolution.detail ?? "unknown"}`);
        }

        const now = Date.now();
        const started: DurableCommandRecord = {
          id: options.id,
          status: "started",
          startedAt: existing?.startedAt ?? now,
          updatedAt: now,
          ownerId: this.ownerId,
          fencingToken: lease.fencingToken,
          leaseExpiresAt: lease.expiresAt,
        };
        await this.state.putCommand(started);
        const accepted = await this.state.getCommand(options.id);
        if (!accepted || accepted.status !== "started" || accepted.fencingToken !== lease.fencingToken || accepted.ownerId !== this.ownerId) {
          throw new Error(`COMMAND_FENCE_REJECTED:${options.id}`);
        }
        try {
          const result = await options.run(signal, lease.fencingToken);
          if (signal.aborted) throw signal.reason ?? new Error(`LEASE_LOST:command:${options.id}`);
          const currentLease = await this.leases.validateLease(`command:${options.id}`, this.ownerId, lease.fencingToken);
          if (!currentLease) {
            await this.state.putCommand({ ...started, updatedAt: Date.now(), error: "uncertain:lease lost before commit", reconciliationRequired: true });
            throw new Error(`COMMAND_FENCE_REJECTED:${options.id}`);
          }
          await this.state.putCommand({ ...started, status: "committed", updatedAt: Date.now(), result, error: undefined, reconciliationRequired: false });
          return result;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await this.state.putCommand({
            ...started,
            status: options.retrySafeOnError ? "failed" : "started",
            updatedAt: Date.now(),
            error: options.retrySafeOnError ? detail : `uncertain:${detail}`,
            reconciliationRequired: !options.retrySafeOnError,
          });
          throw error;
        }
      },
    });
  }
}
