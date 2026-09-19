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
export declare class InMemoryMailboxStore implements MailboxStore {
    #private;
    appendMailbox(agentId: AgentId, message: AgentMessage): Promise<MailboxAppendResult>;
    readMailbox(agentId: AgentId, afterSeq: number, limit?: number): Promise<MailboxEnvelope[]>;
    getMailboxCursor(agentId: AgentId, consumerId: string): Promise<MailboxCursor | undefined>;
    ackMailbox(agentId: AgentId, consumerId: string, throughSeq: number): Promise<MailboxCursor>;
}
