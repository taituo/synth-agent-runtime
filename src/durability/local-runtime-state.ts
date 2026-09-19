import type { WorkspaceId } from "../core/ids.js";
import { canReplaceCommand, canReplaceEffect, type DurableCommandRecord,
  DurableEffectRecord,
  DurableTurnRecord,
  DurableWorkspaceCheckpoint,
  RuntimeStateStore,
  TurnStatus,
} from "./runtime-state.js";

export class LocalRuntimeStateStore implements RuntimeStateStore {
  #commands = new Map<string, DurableCommandRecord>();
  #workspaces = new Map<WorkspaceId, DurableWorkspaceCheckpoint>();
  #turns = new Map<string, DurableTurnRecord>();
  #effects = new Map<string, DurableEffectRecord>();

  async putCommand(record: DurableCommandRecord): Promise<void> {
    const existing = this.#commands.get(record.id);
    if (canReplaceCommand(existing, record)) this.#commands.set(record.id, structuredClone(record));
  }

  async getCommand(id: string): Promise<DurableCommandRecord | undefined> {
    const value = this.#commands.get(id);
    return value ? structuredClone(value) : undefined;
  }

  async claimCommand(record: DurableCommandRecord) {
    const existing = this.#commands.get(record.id);
    if (existing?.status === "committed" || existing?.status === "started") {
      return { claimed: false, record: structuredClone(existing) };
    }
    this.#commands.set(record.id, structuredClone(record));
    return { claimed: true, record: structuredClone(record) };
  }

  async putWorkspaceCheckpoint(checkpoint: DurableWorkspaceCheckpoint): Promise<void> {
    this.#workspaces.set(checkpoint.workspaceId, structuredClone(checkpoint));
  }

  async getWorkspaceCheckpoint(workspaceId: WorkspaceId): Promise<DurableWorkspaceCheckpoint | undefined> {
    const value = this.#workspaces.get(workspaceId);
    return value ? structuredClone(value) : undefined;
  }

  async putTurn(record: DurableTurnRecord): Promise<void> {
    this.#turns.set(record.id, structuredClone(record));
  }

  async getTurn(id: string): Promise<DurableTurnRecord | undefined> {
    const value = this.#turns.get(id);
    return value ? structuredClone(value) : undefined;
  }

  async listTurns(status?: TurnStatus): Promise<DurableTurnRecord[]> {
    return [...this.#turns.values()]
      .filter((value) => status === undefined || value.status === status)
      .map((value) => structuredClone(value));
  }

  async putEffect(record: DurableEffectRecord): Promise<void> {
    const existing = this.#effects.get(record.id);
    if (canReplaceEffect(existing, record)) this.#effects.set(record.id, structuredClone(record));
  }

  async getEffect(id: string): Promise<DurableEffectRecord | undefined> {
    const value = this.#effects.get(id);
    return value ? structuredClone(value) : undefined;
  }

  async claimEffect(record: DurableEffectRecord) {
    const existing = this.#effects.get(record.id);
    if (existing) return { claimed: false, record: structuredClone(existing) };
    this.#effects.set(record.id, structuredClone(record));
    return { claimed: true, record: structuredClone(record) };
  }
}

