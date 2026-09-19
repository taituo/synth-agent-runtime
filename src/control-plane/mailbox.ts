import type { AgentId } from "../core/ids.js";
import type { AgentMessage } from "../core/types.js";

export interface MailboxEnvelope {
  agentId: AgentId;
  seq: number;
  message: AgentMessage;
  appendedAt: number;
}

export interface MailboxAppendResult {
  envelope: MailboxEnvelope;
  inserted: boolean;
}

export interface MailboxCursor {
  agentId: AgentId;
  consumerId: string;
  ackSeq: number;
  updatedAt: number;
}

export interface MailboxStore {
  appendMailbox(agentId: AgentId, message: AgentMessage): Promise<MailboxAppendResult>;
  readMailbox(agentId: AgentId, afterSeq: number, limit?: number): Promise<MailboxEnvelope[]>;
  getMailboxCursor(agentId: AgentId, consumerId: string): Promise<MailboxCursor | undefined>;
  ackMailbox(agentId: AgentId, consumerId: string, throughSeq: number): Promise<MailboxCursor>;
}

export class InMemoryMailboxStore implements MailboxStore {
  readonly #messages = new Map<AgentId, MailboxEnvelope[]>();
  readonly #cursors = new Map<string, MailboxCursor>();

  async appendMailbox(agentId: AgentId, message: AgentMessage): Promise<MailboxAppendResult> {
    const items = this.#messages.get(agentId) ?? [];
    const existing = items.find((item) => item.message.id === message.id);
    if (existing) return { envelope: structuredClone(existing), inserted: false };
    const envelope: MailboxEnvelope = {
      agentId,
      seq: (items.at(-1)?.seq ?? 0) + 1,
      message: structuredClone(message),
      appendedAt: Date.now(),
    };
    items.push(envelope);
    this.#messages.set(agentId, items);
    return { envelope: structuredClone(envelope), inserted: true };
  }

  async readMailbox(agentId: AgentId, afterSeq: number, limit = 1000): Promise<MailboxEnvelope[]> {
    return (this.#messages.get(agentId) ?? []).filter((item) => item.seq > afterSeq).slice(0, Math.max(0, limit)).map((item) => structuredClone(item));
  }

  async getMailboxCursor(agentId: AgentId, consumerId: string): Promise<MailboxCursor | undefined> {
    const cursor = this.#cursors.get(cursorKey(agentId, consumerId));
    return cursor ? structuredClone(cursor) : undefined;
  }

  async ackMailbox(agentId: AgentId, consumerId: string, throughSeq: number): Promise<MailboxCursor> {
    const key = cursorKey(agentId, consumerId);
    const existing = this.#cursors.get(key);
    const maxSeq = this.#messages.get(agentId)?.at(-1)?.seq ?? 0;
    const cursor: MailboxCursor = {
      agentId,
      consumerId,
      ackSeq: Math.max(existing?.ackSeq ?? 0, Math.min(throughSeq, maxSeq)),
      updatedAt: Date.now(),
    };
    this.#cursors.set(key, cursor);
    return structuredClone(cursor);
  }
}

function cursorKey(agentId: AgentId, consumerId: string): string { return `${agentId}\u0000${consumerId}`; }
