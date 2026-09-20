import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceId } from "../core/ids.js";
import { canReplaceCommand, canReplaceEffect, type DurableCommandRecord,
  DurableEffectRecord,
  DurableTurnRecord,
  DurableWorkspaceCheckpoint,
  RuntimeStateStore,
  TurnStatus,
} from "./runtime-state.js";

interface FileState {
  commands: Record<string, DurableCommandRecord>;
  workspaces: Record<string, DurableWorkspaceCheckpoint>;
  turns: Record<string, DurableTurnRecord>;
  effects: Record<string, DurableEffectRecord>;
}

const EMPTY = (): FileState => ({ commands: {}, workspaces: {}, turns: {}, effects: {} });

/**
 * Small crash-safe runtime state store for a single control-plane process.
 * Writes are serialized and use temp-file + rename. For multi-writer production
 * deployments replace this with a transactional database implementation.
 */
export class JsonFileRuntimeStateStore implements RuntimeStateStore {
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async putCommand(record: DurableCommandRecord): Promise<void> {
    await this.#mutate((state) => { if (canReplaceCommand(state.commands[record.id], record)) state.commands[record.id] = structuredClone(record); });
  }

  async getCommand(id: string): Promise<DurableCommandRecord | undefined> {
    const value = (await this.#read()).commands[id];
    return value ? structuredClone(value) : undefined;
  }

  async putWorkspaceCheckpoint(checkpoint: DurableWorkspaceCheckpoint): Promise<void> {
    await this.#mutate((state) => { state.workspaces[checkpoint.workspaceId] = structuredClone(checkpoint); });
  }

  async getWorkspaceCheckpoint(workspaceId: WorkspaceId): Promise<DurableWorkspaceCheckpoint | undefined> {
    const value = (await this.#read()).workspaces[workspaceId];
    return value ? structuredClone(value) : undefined;
  }

  async putTurn(record: DurableTurnRecord): Promise<void> {
    await this.#mutate((state) => { state.turns[record.id] = structuredClone(record); });
  }

  async getTurn(id: string): Promise<DurableTurnRecord | undefined> {
    const value = (await this.#read()).turns[id];
    return value ? structuredClone(value) : undefined;
  }

  async listTurns(status?: TurnStatus): Promise<DurableTurnRecord[]> {
    return Object.values((await this.#read()).turns)
      .filter((record) => status === undefined || record.status === status)
      .map((record) => structuredClone(record));
  }

  async putEffect(record: DurableEffectRecord): Promise<void> {
    await this.#mutate((state) => {
      if (canReplaceEffect(state.effects[record.id], record)) state.effects[record.id] = structuredClone(record);
    });
  }

  async getEffect(id: string): Promise<DurableEffectRecord | undefined> {
    const value = (await this.#read()).effects[id];
    return value ? structuredClone(value) : undefined;
  }

  async #read(): Promise<FileState> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as Partial<FileState>;
      return { commands: parsed.commands ?? {}, workspaces: parsed.workspaces ?? {}, turns: parsed.turns ?? {}, effects: parsed.effects ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY();
      throw error;
    }
  }

  async #mutate(update: (state: FileState) => void): Promise<void> {
    const next = this.#chain.then(async () => {
      const state = await this.#read();
      update(state);
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(state, null, 2));
      await rename(tmp, this.path);
    });
    this.#chain = next.catch(() => {});
    await next;
  }
}
