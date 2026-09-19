import test from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionBroker,
  installPostgresSchema,
  PostgresPersistence,
  type Effect,
  type PgExecutor,
  type PgQueryResult,
} from "../src/index.js";

class FakePg implements PgExecutor {
  readonly commands = new Map<string, unknown>();
  readonly effects = new Map<string, unknown>();

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
      this.effects.set(String(values[0]), JSON.parse(String(values[3])));
      return { rows: [] };
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
