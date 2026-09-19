import type { AgentId } from "../core/ids.js";
import type { AgentMessage } from "../core/types.js";
import type { ContinuationRecord, ContinuationStore } from "../inference/gateway/continuation-store.js";
import type { SharedRateLimitStore } from "../inference/gateway/tenant-policy.js";
import type { RouterStateStore, SharedRouteHealth } from "../inference/gateway/router-state.js";
import type { LeaseClaimResult, LeaseRecord, LeaseStore } from "../control-plane/lease.js";
import type { MailboxAppendResult, MailboxCursor, MailboxEnvelope, MailboxStore } from "../control-plane/mailbox.js";
import type { PgExecutor } from "./types.js";

interface LeaseRow { resource_id: string; owner_id: string; fencing_token: string | number; acquired_at_ms: string | number; updated_at_ms: string | number; expires_at_ms: string | number }
interface MailboxRow { agent_id: string; seq: string | number; body: unknown; appended_at_ms: string | number }
interface CursorRow { agent_id: string; consumer_id: string; ack_seq: string | number; updated_at_ms: string | number }
interface ContinuationRow { id: string; tenant_id: string | null; body: unknown; created_at_ms: string | number; expires_at_ms: string | number | null }
interface RouteHealthRow { route_key: string; body: unknown }
interface AffinityRow { affinity_key: string; route_id: string; expires_at_ms: string | number | null }

/** Shared distributed-control-plane primitives backed by PostgreSQL. */
export class PostgresDistributedControlStore implements LeaseStore, MailboxStore, ContinuationStore, RouterStateStore {
  constructor(readonly db: PgExecutor) {}

  async acquireLease(resourceId: string, ownerId: string, ttlMs: number, _now?: number): Promise<LeaseClaimResult> {
    if (ttlMs <= 0) throw new Error(`Invalid lease ttl: ${ttlMs}`);
    const result = await this.db.query<LeaseRow>(
      `WITH db_clock AS (
         SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms
       )
       INSERT INTO synth_leases(resource_id,owner_id,fencing_token,acquired_at_ms,updated_at_ms,expires_at_ms)
       SELECT $1,$2,1,db_clock.now_ms,db_clock.now_ms,db_clock.now_ms+$3
       FROM db_clock
       ON CONFLICT (resource_id) DO UPDATE SET
         owner_id=EXCLUDED.owner_id,
         fencing_token=synth_leases.fencing_token+1,
         acquired_at_ms=EXCLUDED.acquired_at_ms,
         updated_at_ms=EXCLUDED.updated_at_ms,
         expires_at_ms=EXCLUDED.expires_at_ms
       WHERE synth_leases.expires_at_ms <= EXCLUDED.acquired_at_ms
       RETURNING resource_id,owner_id,fencing_token,acquired_at_ms,updated_at_ms,expires_at_ms`,
      [resourceId, ownerId, ttlMs],
    );
    if (result.rows.length) return { acquired: true, lease: decodeLease(result.rows[0]!) };
    const existing = await this.getLease(resourceId);
    if (!existing) throw new Error(`Lease claim lost without visible row: ${resourceId}`);
    return { acquired: false, lease: existing };
  }

  async renewLease(resourceId: string, ownerId: string, fencingToken: number, ttlMs: number, _now?: number): Promise<LeaseRecord | undefined> {
    if (ttlMs <= 0) throw new Error(`Invalid lease ttl: ${ttlMs}`);
    const result = await this.db.query<LeaseRow>(
      `WITH db_clock AS (
         SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms
       )
       UPDATE synth_leases SET
         updated_at_ms=db_clock.now_ms,
         expires_at_ms=db_clock.now_ms+$4
       FROM db_clock
       WHERE resource_id=$1 AND owner_id=$2 AND fencing_token=$3 AND expires_at_ms>db_clock.now_ms
       RETURNING resource_id,owner_id,fencing_token,acquired_at_ms,updated_at_ms,expires_at_ms`,
      [resourceId, ownerId, fencingToken, ttlMs],
    );
    return result.rows[0] ? decodeLease(result.rows[0]) : undefined;
  }

  async releaseLease(resourceId: string, ownerId: string, fencingToken: number): Promise<boolean> {
    const result = await this.db.query<{ resource_id: string }>(
      `WITH db_clock AS (
         SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms
       )
       UPDATE synth_leases SET updated_at_ms=db_clock.now_ms, expires_at_ms=db_clock.now_ms
       FROM db_clock
       WHERE resource_id=$1 AND owner_id=$2 AND fencing_token=$3
       RETURNING resource_id`,
      [resourceId, ownerId, fencingToken],
    );
    return result.rows.length > 0;
  }

  async getLease(resourceId: string): Promise<LeaseRecord | undefined> {
    const result = await this.db.query<LeaseRow>(
      `SELECT resource_id,owner_id,fencing_token,acquired_at_ms,updated_at_ms,expires_at_ms FROM synth_leases WHERE resource_id=$1`,
      [resourceId],
    );
    return result.rows[0] ? decodeLease(result.rows[0]) : undefined;
  }

  async validateLease(resourceId: string, ownerId: string, fencingToken: number, _now?: number): Promise<LeaseRecord | undefined> {
    const result = await this.db.query<LeaseRow>(
      `WITH db_clock AS (
         SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms
       )
       SELECT resource_id,owner_id,fencing_token,acquired_at_ms,updated_at_ms,expires_at_ms
       FROM synth_leases, db_clock
       WHERE resource_id=$1 AND owner_id=$2 AND fencing_token=$3 AND expires_at_ms>db_clock.now_ms`,
      [resourceId, ownerId, fencingToken],
    );
    return result.rows[0] ? decodeLease(result.rows[0]) : undefined;
  }

  async appendMailbox(agentId: AgentId, message: AgentMessage): Promise<MailboxAppendResult> {
    const inserted = await this.db.query<MailboxRow>(
      `INSERT INTO synth_mailbox(agent_id,message_id,body,appended_at_ms)
       VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (agent_id,message_id) DO NOTHING
       RETURNING agent_id,seq,body,appended_at_ms`,
      [agentId, message.id, JSON.stringify(message), Date.now()],
    );
    let row = inserted.rows[0];
    if (row) return { envelope: decodeMailboxEnvelope(row), inserted: true };
    const existing = await this.db.query<MailboxRow>(
      `SELECT agent_id,seq,body,appended_at_ms FROM synth_mailbox WHERE agent_id=$1 AND message_id=$2`,
      [agentId, message.id],
    );
    row = existing.rows[0];
    if (!row) throw new Error(`Mailbox append conflict row missing for ${agentId}/${message.id}`);
    return { envelope: decodeMailboxEnvelope(row), inserted: false };
  }

  async readMailbox(agentId: AgentId, afterSeq: number, limit = 1000): Promise<MailboxEnvelope[]> {
    const result = await this.db.query<MailboxRow>(
      `SELECT agent_id,seq,body,appended_at_ms FROM synth_mailbox WHERE agent_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`,
      [agentId, afterSeq, Math.max(0, limit)],
    );
    return result.rows.map((row) => ({ agentId: row.agent_id as AgentId, seq: Number(row.seq), message: decode<AgentMessage>(row.body), appendedAt: Number(row.appended_at_ms) }));
  }

  async getMailboxCursor(agentId: AgentId, consumerId: string): Promise<MailboxCursor | undefined> {
    const result = await this.db.query<CursorRow>(
      `SELECT agent_id,consumer_id,ack_seq,updated_at_ms FROM synth_mailbox_cursors WHERE agent_id=$1 AND consumer_id=$2`,
      [agentId, consumerId],
    );
    const row = result.rows[0];
    return row ? { agentId: row.agent_id as AgentId, consumerId: row.consumer_id, ackSeq: Number(row.ack_seq), updatedAt: Number(row.updated_at_ms) } : undefined;
  }

  async ackMailbox(agentId: AgentId, consumerId: string, throughSeq: number): Promise<MailboxCursor> {
    const now = Date.now();
    const result = await this.db.query<CursorRow>(
      `INSERT INTO synth_mailbox_cursors(agent_id,consumer_id,ack_seq,updated_at_ms)
       VALUES ($1,$2,LEAST($3,COALESCE((SELECT max(seq) FROM synth_mailbox WHERE agent_id=$1),0)),$4)
       ON CONFLICT (agent_id,consumer_id) DO UPDATE SET
         ack_seq=GREATEST(synth_mailbox_cursors.ack_seq,LEAST($3,COALESCE((SELECT max(seq) FROM synth_mailbox WHERE agent_id=$1),0))),
         updated_at_ms=EXCLUDED.updated_at_ms
       RETURNING agent_id,consumer_id,ack_seq,updated_at_ms`,
      [agentId, consumerId, throughSeq, now],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Mailbox ack returned no row for ${agentId}/${consumerId}`);
    return { agentId: row.agent_id as AgentId, consumerId: row.consumer_id, ackSeq: Number(row.ack_seq), updatedAt: Number(row.updated_at_ms) };
  }

  async putContinuation(record: ContinuationRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO synth_continuations(id,tenant_id,body,created_at_ms,expires_at_ms) VALUES ($1,$2,$3::jsonb,$4,$5)
       ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,body=EXCLUDED.body,created_at_ms=EXCLUDED.created_at_ms,expires_at_ms=EXCLUDED.expires_at_ms`,
      [record.id, record.tenantId ?? null, JSON.stringify(record.value), record.createdAt, record.expiresAt ?? null],
    );
  }

  async getContinuation(id: string, tenantId?: string): Promise<ContinuationRecord | undefined> {
    const result = await this.db.query<ContinuationRow>(
      `SELECT id,tenant_id,body,created_at_ms,expires_at_ms FROM synth_continuations
       WHERE id=$1 AND (expires_at_ms IS NULL OR expires_at_ms>$2)`,
      [id, Date.now()],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if ((tenantId ?? undefined) !== (row.tenant_id ?? undefined)) return undefined;
    return { id: row.id, tenantId: row.tenant_id ?? undefined, value: decode(row.body), createdAt: Number(row.created_at_ms), expiresAt: row.expires_at_ms === null ? undefined : Number(row.expires_at_ms) };
  }

  async deleteContinuation(id: string): Promise<void> { await this.db.query(`DELETE FROM synth_continuations WHERE id=$1`, [id]); }
  async pruneContinuations(now = Date.now()): Promise<number> {
    const result = await this.db.query<{ id: string }>(`DELETE FROM synth_continuations WHERE expires_at_ms IS NOT NULL AND expires_at_ms<=$1 RETURNING id`, [now]);
    return result.rows.length;
  }

  async getRouteHealth(routeKey: string): Promise<SharedRouteHealth | undefined> {
    const result = await this.db.query<RouteHealthRow>(`SELECT route_key,body FROM synth_route_health WHERE route_key=$1`, [routeKey]);
    return result.rows[0] ? decode<SharedRouteHealth>(result.rows[0].body) : undefined;
  }
  async putRouteHealth(health: SharedRouteHealth): Promise<void> {
    await this.db.query(
      `INSERT INTO synth_route_health(route_key,body,updated_at_ms) VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (route_key) DO UPDATE SET body=EXCLUDED.body,updated_at_ms=EXCLUDED.updated_at_ms`,
      [health.routeKey, JSON.stringify(health), health.updatedAt],
    );
  }
  async getAffinity(key: string): Promise<string | undefined> {
    const result = await this.db.query<AffinityRow>(
      `SELECT affinity_key,route_id,expires_at_ms FROM synth_route_affinity WHERE affinity_key=$1 AND (expires_at_ms IS NULL OR expires_at_ms>$2)`,
      [key, Date.now()],
    );
    return result.rows[0]?.route_id;
  }
  async putAffinity(key: string, routeId: string, expiresAt?: number): Promise<void> {
    await this.db.query(
      `INSERT INTO synth_route_affinity(affinity_key,route_id,expires_at_ms,updated_at_ms) VALUES ($1,$2,$3,$4)
       ON CONFLICT (affinity_key) DO UPDATE SET route_id=EXCLUDED.route_id,expires_at_ms=EXCLUDED.expires_at_ms,updated_at_ms=EXCLUDED.updated_at_ms`,
      [key, routeId, expiresAt ?? null, Date.now()],
    );
  }
  async deleteAffinity(key: string): Promise<void> { await this.db.query(`DELETE FROM synth_route_affinity WHERE affinity_key=$1`, [key]); }
}

/**
 * Shared tenant rate-limit counter backed by PostgreSQL. The upsert is atomic,
 * so multiple gateway replicas increment the same per-(tenant, window) row and
 * a tenant's configured limit is global rather than per-process.
 */
export class PostgresRateLimitStore implements SharedRateLimitStore {
  constructor(readonly db: PgExecutor) {}

  async increment(tenantId: string, windowStartMs: number): Promise<number> {
    const result = await this.db.query<{ count: string | number }>(
      `INSERT INTO synth_rate_limits(tenant_id,window_start_ms,count,updated_at)
       VALUES ($1,$2,1,now())
       ON CONFLICT (tenant_id,window_start_ms)
       DO UPDATE SET count=synth_rate_limits.count+1, updated_at=now()
       RETURNING count`,
      [tenantId, windowStartMs],
    );
    return Number(result.rows[0]!.count);
  }

  async prune(beforeMs: number): Promise<number> {
    const result = await this.db.query<{ tenant_id: string }>(
      `DELETE FROM synth_rate_limits WHERE window_start_ms < $1 RETURNING tenant_id`,
      [beforeMs],
    );
    return result.rows.length;
  }
}


function decodeMailboxEnvelope(row: MailboxRow): MailboxEnvelope {
  return {
    agentId: row.agent_id as AgentId,
    seq: Number(row.seq),
    message: decode<AgentMessage>(row.body),
    appendedAt: Number(row.appended_at_ms),
  };
}
function decodeLease(row: LeaseRow): LeaseRecord {
  return { resourceId: row.resource_id, ownerId: row.owner_id, fencingToken: Number(row.fencing_token), acquiredAt: Number(row.acquired_at_ms), updatedAt: Number(row.updated_at_ms), expiresAt: Number(row.expires_at_ms) };
}
function decode<T = unknown>(value: unknown): T { return structuredClone((typeof value === "string" ? JSON.parse(value) : value) as T); }
