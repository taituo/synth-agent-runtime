/** Shared distributed-control-plane primitives backed by PostgreSQL. */
export class PostgresDistributedControlStore {
    db;
    constructor(db) {
        this.db = db;
    }
    async acquireLease(resourceId, ownerId, ttlMs, _now) {
        if (ttlMs <= 0)
            throw new Error(`Invalid lease ttl: ${ttlMs}`);
        const result = await this.db.query(`WITH db_clock AS (
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
       RETURNING resource_id,owner_id,fencing_token,acquired_at_ms,updated_at_ms,expires_at_ms`, [resourceId, ownerId, ttlMs]);
        if (result.rows.length)
            return { acquired: true, lease: decodeLease(result.rows[0]) };
        const existing = await this.getLease(resourceId);
        if (!existing)
            throw new Error(`Lease claim lost without visible row: ${resourceId}`);
        return { acquired: false, lease: existing };
    }
    async renewLease(resourceId, ownerId, fencingToken, ttlMs, _now) {
        if (ttlMs <= 0)
            throw new Error(`Invalid lease ttl: ${ttlMs}`);
        const result = await this.db.query(`WITH db_clock AS (
         SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms
       )
       UPDATE synth_leases SET
         updated_at_ms=db_clock.now_ms,
         expires_at_ms=db_clock.now_ms+$4
       FROM db_clock
       WHERE resource_id=$1 AND owner_id=$2 AND fencing_token=$3 AND expires_at_ms>db_clock.now_ms
       RETURNING resource_id,owner_id,fencing_token,acquired_at_ms,updated_at_ms,expires_at_ms`, [resourceId, ownerId, fencingToken, ttlMs]);
        return result.rows[0] ? decodeLease(result.rows[0]) : undefined;
    }
    async releaseLease(resourceId, ownerId, fencingToken) {
        const result = await this.db.query(`WITH db_clock AS (
         SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms
       )
       UPDATE synth_leases SET updated_at_ms=db_clock.now_ms, expires_at_ms=db_clock.now_ms
       FROM db_clock
       WHERE resource_id=$1 AND owner_id=$2 AND fencing_token=$3
       RETURNING resource_id`, [resourceId, ownerId, fencingToken]);
        return result.rows.length > 0;
    }
    async getLease(resourceId) {
        const result = await this.db.query(`SELECT resource_id,owner_id,fencing_token,acquired_at_ms,updated_at_ms,expires_at_ms FROM synth_leases WHERE resource_id=$1`, [resourceId]);
        return result.rows[0] ? decodeLease(result.rows[0]) : undefined;
    }
    async validateLease(resourceId, ownerId, fencingToken, _now) {
        const result = await this.db.query(`WITH db_clock AS (
         SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms
       )
       SELECT resource_id,owner_id,fencing_token,acquired_at_ms,updated_at_ms,expires_at_ms
       FROM synth_leases, db_clock
       WHERE resource_id=$1 AND owner_id=$2 AND fencing_token=$3 AND expires_at_ms>db_clock.now_ms`, [resourceId, ownerId, fencingToken]);
        return result.rows[0] ? decodeLease(result.rows[0]) : undefined;
    }
    async appendMailbox(agentId, message) {
        const inserted = await this.db.query(`INSERT INTO synth_mailbox(agent_id,message_id,body,appended_at_ms)
       VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (agent_id,message_id) DO NOTHING
       RETURNING agent_id,seq,body,appended_at_ms`, [agentId, message.id, JSON.stringify(message), Date.now()]);
        let row = inserted.rows[0];
        if (row)
            return { envelope: decodeMailboxEnvelope(row), inserted: true };
        const existing = await this.db.query(`SELECT agent_id,seq,body,appended_at_ms FROM synth_mailbox WHERE agent_id=$1 AND message_id=$2`, [agentId, message.id]);
        row = existing.rows[0];
        if (!row)
            throw new Error(`Mailbox append conflict row missing for ${agentId}/${message.id}`);
        return { envelope: decodeMailboxEnvelope(row), inserted: false };
    }
    async readMailbox(agentId, afterSeq, limit = 1000) {
        const result = await this.db.query(`SELECT agent_id,seq,body,appended_at_ms FROM synth_mailbox WHERE agent_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`, [agentId, afterSeq, Math.max(0, limit)]);
        return result.rows.map((row) => ({ agentId: row.agent_id, seq: Number(row.seq), message: decode(row.body), appendedAt: Number(row.appended_at_ms) }));
    }
    async getMailboxCursor(agentId, consumerId) {
        const result = await this.db.query(`SELECT agent_id,consumer_id,ack_seq,updated_at_ms FROM synth_mailbox_cursors WHERE agent_id=$1 AND consumer_id=$2`, [agentId, consumerId]);
        const row = result.rows[0];
        return row ? { agentId: row.agent_id, consumerId: row.consumer_id, ackSeq: Number(row.ack_seq), updatedAt: Number(row.updated_at_ms) } : undefined;
    }
    async ackMailbox(agentId, consumerId, throughSeq) {
        const now = Date.now();
        const result = await this.db.query(`INSERT INTO synth_mailbox_cursors(agent_id,consumer_id,ack_seq,updated_at_ms)
       VALUES ($1,$2,LEAST($3,COALESCE((SELECT max(seq) FROM synth_mailbox WHERE agent_id=$1),0)),$4)
       ON CONFLICT (agent_id,consumer_id) DO UPDATE SET
         ack_seq=GREATEST(synth_mailbox_cursors.ack_seq,LEAST($3,COALESCE((SELECT max(seq) FROM synth_mailbox WHERE agent_id=$1),0))),
         updated_at_ms=EXCLUDED.updated_at_ms
       RETURNING agent_id,consumer_id,ack_seq,updated_at_ms`, [agentId, consumerId, throughSeq, now]);
        const row = result.rows[0];
        if (!row)
            throw new Error(`Mailbox ack returned no row for ${agentId}/${consumerId}`);
        return { agentId: row.agent_id, consumerId: row.consumer_id, ackSeq: Number(row.ack_seq), updatedAt: Number(row.updated_at_ms) };
    }
    async putContinuation(record) {
        await this.db.query(`INSERT INTO synth_continuations(id,tenant_id,body,created_at_ms,expires_at_ms) VALUES ($1,$2,$3::jsonb,$4,$5)
       ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,body=EXCLUDED.body,created_at_ms=EXCLUDED.created_at_ms,expires_at_ms=EXCLUDED.expires_at_ms`, [record.id, record.tenantId ?? null, JSON.stringify(record.value), record.createdAt, record.expiresAt ?? null]);
    }
    async getContinuation(id, tenantId) {
        const result = await this.db.query(`SELECT id,tenant_id,body,created_at_ms,expires_at_ms FROM synth_continuations
       WHERE id=$1 AND (expires_at_ms IS NULL OR expires_at_ms>$2)`, [id, Date.now()]);
        const row = result.rows[0];
        if (!row)
            return undefined;
        if ((tenantId ?? undefined) !== (row.tenant_id ?? undefined))
            return undefined;
        return { id: row.id, tenantId: row.tenant_id ?? undefined, value: decode(row.body), createdAt: Number(row.created_at_ms), expiresAt: row.expires_at_ms === null ? undefined : Number(row.expires_at_ms) };
    }
    async deleteContinuation(id) { await this.db.query(`DELETE FROM synth_continuations WHERE id=$1`, [id]); }
    async pruneContinuations(now = Date.now()) {
        const result = await this.db.query(`DELETE FROM synth_continuations WHERE expires_at_ms IS NOT NULL AND expires_at_ms<=$1 RETURNING id`, [now]);
        return result.rows.length;
    }
    async getRouteHealth(routeKey) {
        const result = await this.db.query(`SELECT route_key,body FROM synth_route_health WHERE route_key=$1`, [routeKey]);
        return result.rows[0] ? decode(result.rows[0].body) : undefined;
    }
    async putRouteHealth(health) {
        await this.db.query(`INSERT INTO synth_route_health(route_key,body,updated_at_ms) VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (route_key) DO UPDATE SET body=EXCLUDED.body,updated_at_ms=EXCLUDED.updated_at_ms`, [health.routeKey, JSON.stringify(health), health.updatedAt]);
    }
    async getAffinity(key) {
        const result = await this.db.query(`SELECT affinity_key,route_id,expires_at_ms FROM synth_route_affinity WHERE affinity_key=$1 AND (expires_at_ms IS NULL OR expires_at_ms>$2)`, [key, Date.now()]);
        return result.rows[0]?.route_id;
    }
    async putAffinity(key, routeId, expiresAt) {
        await this.db.query(`INSERT INTO synth_route_affinity(affinity_key,route_id,expires_at_ms,updated_at_ms) VALUES ($1,$2,$3,$4)
       ON CONFLICT (affinity_key) DO UPDATE SET route_id=EXCLUDED.route_id,expires_at_ms=EXCLUDED.expires_at_ms,updated_at_ms=EXCLUDED.updated_at_ms`, [key, routeId, expiresAt ?? null, Date.now()]);
    }
    async deleteAffinity(key) { await this.db.query(`DELETE FROM synth_route_affinity WHERE affinity_key=$1`, [key]); }
}
/**
 * Shared tenant rate-limit counter backed by PostgreSQL. The upsert is atomic,
 * so multiple gateway replicas increment the same per-(tenant, window) row and
 * a tenant's configured limit is global rather than per-process.
 */
export class PostgresRateLimitStore {
    db;
    constructor(db) {
        this.db = db;
    }
    async increment(tenantId, windowStartMs) {
        const result = await this.db.query(`INSERT INTO synth_rate_limits(tenant_id,window_start_ms,count,updated_at)
       VALUES ($1,$2,1,now())
       ON CONFLICT (tenant_id,window_start_ms)
       DO UPDATE SET count=synth_rate_limits.count+1, updated_at=now()
       RETURNING count`, [tenantId, windowStartMs]);
        return Number(result.rows[0].count);
    }
    async prune(beforeMs) {
        const result = await this.db.query(`DELETE FROM synth_rate_limits WHERE window_start_ms < $1 RETURNING tenant_id`, [beforeMs]);
        return result.rows.length;
    }
}
function decodeMailboxEnvelope(row) {
    return {
        agentId: row.agent_id,
        seq: Number(row.seq),
        message: decode(row.body),
        appendedAt: Number(row.appended_at_ms),
    };
}
function decodeLease(row) {
    return { resourceId: row.resource_id, ownerId: row.owner_id, fencingToken: Number(row.fencing_token), acquiredAt: Number(row.acquired_at_ms), updatedAt: Number(row.updated_at_ms), expiresAt: Number(row.expires_at_ms) };
}
function decode(value) { return structuredClone((typeof value === "string" ? JSON.parse(value) : value)); }
