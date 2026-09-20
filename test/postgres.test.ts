import test from "node:test";
import assert from "node:assert/strict";
import {
  canReplaceEffect,
  ExecutionBroker,
  installPostgresSchema,
  PostgresPersistence,
  PostgresRateLimitStore,
  SharedTenantRateLimitPolicy,
  type Effect,
  type PgExecutor,
  type PgQueryResult,
} from "../src/index.js";

class FakePg implements PgExecutor {
  readonly commands = new Map<string, unknown>();
  readonly effects = new Map<string, unknown>();
  readonly rateLimits = new Map<string, number>();
  readonly tasks = new Map<string, unknown>();
  readonly artifacts = new Map<string, unknown>();
  readonly eventCursors = new Map<string, { ack_seq: number; updated_at_ms: number }>();
  eventMaxSeq = 0;

  async query<Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<PgQueryResult<Row>> {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("INSERT INTO synth_commands") && sql.includes("RETURNING body")) {
      const id = String(values[0]);
      const body = JSON.parse(String(values[2]));
      const existing = this.commands.get(id) as any;
      if (!existing || existing.status === "failed") {
        this.commands.set(id, body);
        return { rows: [{ body } as Row] };
      }
      return { rows: [] };
    }
    if (sql.startsWith("SELECT body FROM synth_commands WHERE id=$1")) {
      const body = this.commands.get(String(values[0]));
      return { rows: body ? [{ body } as Row] : [] };
    }
    if (sql.startsWith("INSERT INTO synth_commands")) {
      this.commands.set(String(values[0]), JSON.parse(String(values[2])));
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO synth_effects") && sql.includes("DO NOTHING") && sql.includes("RETURNING body")) {
      const id = String(values[0]);
      if (this.effects.has(id)) return { rows: [] };
      const body = JSON.parse(String(values[3]));
      this.effects.set(id, body);
      return { rows: [{ body } as Row] };
    }
    if (sql.startsWith("SELECT body FROM synth_effects WHERE id=$1")) {
      const body = this.effects.get(String(values[0]));
      return { rows: body ? [{ body } as Row] : [] };
    }
    if (sql.startsWith("INSERT INTO synth_effects")) {
      const id = String(values[0]);
      const next = JSON.parse(String(values[3]));
      const existing = this.effects.get(id) as any;
      // Honor the WHERE clause on the upsert (canReplaceEffect semantics).
      if (!existing || canReplaceEffect(existing, next)) this.effects.set(id, next);
      return { rows: [] };
    }
    if (sql.startsWith("WITH max_seq AS") && sql.includes("INSERT INTO synth_event_cursors")) {
      const id = String(values[0]);
      const ack = Math.max(this.eventCursors.get(id)?.ack_seq ?? 0, Math.min(Number(values[1]), this.eventMaxSeq));
      const row = { ack_seq: ack, updated_at_ms: Number(values[2]) };
      this.eventCursors.set(id, row);
      return { rows: [{ ack_seq: ack, updated_at_ms: row.updated_at_ms } as Row] };
    }
    if (sql.startsWith("SELECT consumer_id,ack_seq,updated_at_ms FROM synth_event_cursors WHERE consumer_id=$1")) {
      const row = this.eventCursors.get(String(values[0]));
      return { rows: row ? [{ consumer_id: String(values[0]), ...row } as Row] : [] };
    }
    if (sql.startsWith("SELECT consumer_id,ack_seq,updated_at_ms FROM synth_event_cursors")) {
      return { rows: [...this.eventCursors.entries()].map(([consumer_id, row]) => ({ consumer_id, ...row } as Row)) };
    }
    if (sql.startsWith("DELETE FROM synth_event_cursors")) {
      const id = String(values[0]);
      const had = this.eventCursors.delete(id);
      return { rows: had ? [{ consumer_id: id } as Row] : [] };
    }
    if (sql.startsWith("SELECT COALESCE(MIN(ack_seq),0) AS watermark FROM synth_event_cursors")) {
      const min = this.eventCursors.size === 0 ? 0 : Math.min(...[...this.eventCursors.values()].map((r) => r.ack_seq));
      return { rows: [{ watermark: min } as Row] };
    }
    if (sql.startsWith("UPDATE synth_tasks SET body=$2::jsonb")) {
      const id = String(values[0]);
      const next = JSON.parse(String(values[1]));
      const existing = this.tasks.get(id) as any;
      if (!existing || (existing.revision ?? 0) !== Number(values[2])) return { rows: [] };
      this.tasks.set(id, next);
      return { rows: [{ body: next } as Row] };
    }
    if (sql.startsWith("SELECT body FROM synth_tasks WHERE id=$1")) {
      const body = this.tasks.get(String(values[0]));
      return { rows: body ? [{ body } as Row] : [] };
    }
    if (sql.startsWith("UPDATE synth_artifacts SET body=$2::jsonb")) {
      const id = String(values[0]);
      const next = JSON.parse(String(values[1]));
      const existing = this.artifacts.get(id) as any;
      if (!existing || (existing.revision ?? 0) !== Number(values[2])) return { rows: [] };
      this.artifacts.set(id, next);
      return { rows: [{ body: next } as Row] };
    }
    if (sql.startsWith("SELECT body FROM synth_artifacts WHERE id=$1")) {
      const body = this.artifacts.get(String(values[0]));
      return { rows: body ? [{ body } as Row] : [] };
    }
    if (sql.startsWith("INSERT INTO synth_rate_limits")) {
      const key = `${values[0]}@${values[1]}`;
      const next = (this.rateLimits.get(key) ?? 0) + 1;
      this.rateLimits.set(key, next);
      return { rows: [{ count: next } as Row] };
    }
    if (sql.startsWith("DELETE FROM synth_rate_limits")) {
      const before = Number(values[0]);
      let removed = 0;
      for (const key of [...this.rateLimits.keys()]) {
        const at = Number(key.slice(key.lastIndexOf("@") + 1));
        if (at < before) { this.rateLimits.delete(key); removed++; }
      }
      return { rows: Array.from({ length: removed }, () => ({ tenant_id: "t" } as Row)) };
    }
    throw new Error(`FakePg does not implement SQL: ${sql}`);
  }
}

test("Postgres atomic command claim allows only one active owner", async () => {
  const db = new FakePg();
  const store = new PostgresPersistence(db);
  const record = { id: "cmd-1", status: "started" as const, startedAt: 1, updatedAt: 1 };
  const first = await store.claimCommand(record);
  const second = await store.claimCommand(record);
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.record.status, "started");
});

test("Postgres effect claim prevents duplicate executor calls", async () => {
  const db = new FakePg();
  const store = new PostgresPersistence(db);
  let executions = 0;
  const brokerA = new ExecutionBroker([{ id: "exec", fidelity: 1, canExecute: () => true, async execute() { executions++; return { ok: true, output: executions }; } }], store);
  const brokerB = new ExecutionBroker([{ id: "exec", fidelity: 1, canExecute: () => true, async execute() { executions++; return { ok: true, output: executions }; } }], store);
  const effect: Effect = { id: "effect-1", kind: "process.exec", command: "true" };
  const context = { agentId: "a" as any, workspaceId: "w" as any };
  const one = await brokerA.execute(effect, context);
  const two = await brokerB.execute(effect, context);
  assert.equal(executions, 1);
  assert.deepEqual(two, one);
});

test("Postgres event retention watermark tracks the slowest consumer", async () => {
  const db = new FakePg();
  db.eventMaxSeq = 5;
  const store = new PostgresPersistence(db);
  assert.equal(await store.safeEventWatermark(), 0, "no consumers must fail closed");
  await store.ackEvent("c1", 3);
  await store.ackEvent("c2", 5);
  assert.equal(await store.safeEventWatermark(), 3);
  assert.equal((await store.ackEvent("c1", 99)).ackSeq, 5, "acks are clamped to the max sequence");
  assert.equal((await store.ackEvent("c1", 1)).ackSeq, 5, "acks are monotonic");
  assert.equal(await store.safeEventWatermark(), 5);
  assert.equal(await store.forgetEventConsumer("c2"), true);
  assert.deepEqual((await store.listEventCursors()).map((c) => c.consumerId), ["c1"]);
  assert.equal(await store.forgetEventConsumer("c2"), false);
});

test("Postgres task and artifact compare-and-swap rejects a stale revision", async () => {
  const db = new FakePg();
  const store = new PostgresPersistence(db);
  db.tasks.set("t1", { id: "t1", title: "t", objective: "o", status: "pending" });
  const first = await store.compareAndSwapTask({ id: "t1", title: "t", objective: "o", status: "running" } as any, 0);
  assert.equal(first.swapped, true);
  assert.equal((first.task as any).revision, 1);
  const stale = await store.compareAndSwapTask({ id: "t1", title: "t", objective: "o", status: "completed" } as any, 0);
  assert.equal(stale.swapped, false);
  assert.equal((stale.task as any).status, "running");

  const ref = (v: number) => ({ digest: `sha256:${String(v).padStart(64, "0")}`, size: v, mediaType: "text/plain", mechanism: "test" });
  db.artifacts.set("a1", { id: "a1", type: "report", createdAt: 1, ref: ref(1) });
  const artifactFirst = await store.compareAndSwapArtifact({ id: "a1", type: "report", createdAt: 1, ref: ref(2) } as any, 0);
  assert.equal(artifactFirst.swapped, true);
  assert.equal((artifactFirst.artifact as any).revision, 1);
  const artifactStale = await store.compareAndSwapArtifact({ id: "a1", type: "report", createdAt: 1, ref: ref(3) } as any, 0);
  assert.equal(artifactStale.swapped, false);
  assert.equal((artifactStale.artifact as any).ref.size, 2);
});

test("Postgres rate limit store shares one counter across store instances", async () => {
  const db = new FakePg();
  const policyA = new SharedTenantRateLimitPolicy(new PostgresRateLimitStore(db), 60_000, () => 0);
  const policyB = new SharedTenantRateLimitPolicy(new PostgresRateLimitStore(db), 60_000, () => 0);
  const principal = { tenantId: "t1", subject: "u", requestsPerMinute: 2 };
  const attempt = async (policy: SharedTenantRateLimitPolicy) => {
    try { await policy.authorize(principal); return "ok"; } catch { return "limited"; }
  };
  assert.deepEqual(
    [await attempt(policyA), await attempt(policyB), await attempt(policyA)],
    ["ok", "ok", "limited"],
  );
  assert.equal(await new PostgresRateLimitStore(db).prune(60_000), 1);
});

test("Postgres effect upsert cannot regress a committed receipt", async () => {
  const db = new FakePg();
  const store = new PostgresPersistence(db);
  await store.putEffect({ id: "e1", kind: "workflow.run", status: "started", startedAt: 1, updatedAt: 1 });
  await store.putEffect({ id: "e1", kind: "workflow.run", status: "committed", startedAt: 1, updatedAt: 2, result: { ok: true, output: "done" } });
  await store.putEffect({ id: "e1", kind: "workflow.run", status: "started", startedAt: 1, updatedAt: 3, error: "pending:x" });
  const after = await store.getEffect("e1");
  assert.equal(after?.status, "committed");
  assert.deepEqual(after?.result, { ok: true, output: "done" });
});

test("schema install takes a transaction-scoped advisory lock before any DDL", async () => {
  // Regression for a real race found under 256-way concurrent bootstrap on
  // live PostgreSQL: every statement in POSTGRES_SCHEMA_SQL is individually
  // "IF NOT EXISTS", but the existence-check-then-create is not atomic
  // against a second session doing the same DDL at the same instant, and
  // concurrent callers hit `duplicate key ... pg_type_typname_nsp_index`.
  // This only asserts the lock statement precedes the schema DDL in the one
  // query text sent (so node-postgres runs it on a single connection as one
  // implicit transaction) — the actual cross-session serialization can only
  // be proven against real PostgreSQL, see integrations/postgres/concurrency.ts.
  let sentText = "";
  const db: PgExecutor = {
    async query(text) {
      sentText = text;
      return { rows: [] };
    },
  };
  await installPostgresSchema(db);
  const lockIndex = sentText.indexOf("pg_advisory_xact_lock(");
  const ddlIndex = sentText.indexOf("CREATE TABLE");
  assert.ok(lockIndex >= 0, "must take an advisory lock");
  assert.ok(ddlIndex > lockIndex, "the lock must be acquired before any DDL runs");
});
