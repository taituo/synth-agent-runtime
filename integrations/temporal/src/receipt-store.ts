import { Context as ActivityContext } from "@temporalio/activity";
import type { WorkspaceId } from "../../../src/core/ids.js";
import { LocalRuntimeStateStore } from "../../../src/durability/local-runtime-state.js";
import {
  canReplaceEffect,
  type ClaimResult,
  type DurableCommandRecord,
  type DurableEffectRecord,
  type DurableTurnRecord,
  type DurableWorkspaceCheckpoint,
  type RuntimeStateStore,
  type TurnStatus,
} from "../../../src/durability/runtime-state.js";

/** The key under which effect receipts travel in the activity heartbeat details. */
const RECEIPTS_KEY = "synthEffectReceipts";

export interface EffectReceiptDetails {
  [RECEIPTS_KEY]?: DurableEffectRecord[];
}

/**
 * A `RuntimeStateStore` whose effect receipts live in Temporal activity state.
 *
 * Temporal persists an activity's heartbeat details and hands them back to the
 * next attempt (`Context.current().info.heartbeatDetails`). Storing the receipts
 * there means an activity retry — in the same worker or after a worker restart —
 * starts with the committed receipts, so `ExecutionBroker` dedupes by
 * `effect.id` instead of re-executing a committed effect. This is the bar's
 * "effect receipts live in Temporal state"; no second database is introduced.
 *
 * The non-effect records (commands, turns, workspace checkpoints) are not used
 * by the broker and are delegated to the existing in-memory store.
 *
 * Note: heartbeat details are payload-bounded (Temporal's blob size limit), so
 * a receipt whose `result` is very large should reference its bytes rather than
 * inline them. Effect results here are small.
 */
export class TemporalActivityStateStore implements RuntimeStateStore {
  readonly #inner = new LocalRuntimeStateStore();
  readonly #effects = new Map<string, DurableEffectRecord>();
  readonly #write: (details: EffectReceiptDetails) => void;

  constructor(seed?: unknown, write?: (details: EffectReceiptDetails) => void) {
    for (const record of (seed as EffectReceiptDetails | undefined)?.[RECEIPTS_KEY] ?? []) {
      this.#effects.set(record.id, record);
    }
    this.#write = write ?? ((details) => {
      try {
        ActivityContext.current().heartbeat(details);
      } catch {
        // Not inside a Temporal activity (unit tests, direct callers): the
        // in-memory map still dedupes within the process.
      }
    });
  }

  /**
   * The store for the current activity attempt, seeded from the heartbeat
   * details Temporal captured on the previous attempt. Returns undefined when
   * not running inside an activity.
   */
  static fromCurrentActivity(): TemporalActivityStateStore | undefined {
    try {
      return new TemporalActivityStateStore(ActivityContext.current().info.heartbeatDetails);
    } catch {
      return undefined;
    }
  }

  /** The exact details written to Temporal (also the test seam). */
  snapshot(): EffectReceiptDetails {
    return { [RECEIPTS_KEY]: [...this.#effects.values()] };
  }

  /** Re-persist the current receipts (the activity's periodic heartbeat). */
  heartbeat(): void {
    this.#write(this.snapshot());
  }

  async putEffect(record: DurableEffectRecord): Promise<void> {
    if (!canReplaceEffect(this.#effects.get(record.id), record)) return;
    this.#effects.set(record.id, structuredClone(record));
    this.heartbeat();
  }

  async getEffect(id: string): Promise<DurableEffectRecord | undefined> {
    const value = this.#effects.get(id);
    return value ? structuredClone(value) : undefined;
  }

  async claimEffect(record: DurableEffectRecord): Promise<ClaimResult<DurableEffectRecord>> {
    const existing = this.#effects.get(record.id);
    if (existing) return { claimed: false, record: structuredClone(existing) };
    this.#effects.set(record.id, structuredClone(record));
    this.heartbeat();
    return { claimed: true, record: structuredClone(record) };
  }

  putCommand(record: DurableCommandRecord): Promise<void> {
    return this.#inner.putCommand(record);
  }

  getCommand(id: string): Promise<DurableCommandRecord | undefined> {
    return this.#inner.getCommand(id);
  }

  claimCommand(record: DurableCommandRecord): Promise<ClaimResult<DurableCommandRecord>> {
    return this.#inner.claimCommand(record);
  }

  putWorkspaceCheckpoint(checkpoint: DurableWorkspaceCheckpoint): Promise<void> {
    return this.#inner.putWorkspaceCheckpoint(checkpoint);
  }

  getWorkspaceCheckpoint(workspaceId: WorkspaceId): Promise<DurableWorkspaceCheckpoint | undefined> {
    return this.#inner.getWorkspaceCheckpoint(workspaceId);
  }

  putTurn(record: DurableTurnRecord): Promise<void> {
    return this.#inner.putTurn(record);
  }

  getTurn(id: string): Promise<DurableTurnRecord | undefined> {
    return this.#inner.getTurn(id);
  }

  listTurns(status?: TurnStatus): Promise<DurableTurnRecord[]> {
    return this.#inner.listTurns(status);
  }
}
