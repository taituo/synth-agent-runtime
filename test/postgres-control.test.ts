import test from "node:test";
import assert from "node:assert/strict";
import {
  PostgresDistributedControlStore,
  PostgresPersistence,
  type AgentSnapshot,
  type PgExecutor,
  type PgQueryResult,
} from "../src/index.js";

const fence = (agentId: string, ownerId: string, fencingToken: number) => ({
  resourceId: `agent:${agentId}`,
  ownerId,
  fencingToken,
});

interface QueryCall { text: string; values: unknown[] }

/**
 * Specialised fake for the lease/fenced-write SQL. Every lease statement must
 * use the database clock (`clock_timestamp()`), never a worker-supplied time.
 */
class RecordingPg implements PgExecutor {
  readonly calls: QueryCall[] = [];
  async query<Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<PgQueryResult<Row>> {
    this.calls.push({ text, values });
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.includes("INSERT INTO synth_leases")) {
      return { rows: [{ resource_id: values[0], owner_id: values[1], fencing_token: 7, acquired_at_ms: 1000, updated_at_ms: 1000, expires_at_ms: 6000 } as Row] };
    }
    if (sql.includes("UPDATE synth_leases SET") && sql.includes("expires_at_ms=db_clock.now_ms+$4")) {
      return { rows: [{ resource_id: values[0], owner_id: values[1], fencing_token: values[2], acquired_at_ms: 1000, updated_at_ms: 2000, expires_at_ms: 7000 } as Row] };
    }
    if (sql.includes("FROM synth_leases, db_clock") && sql.includes("expires_at_ms>db_clock.now_ms")) {
      if (sql.includes("INSERT INTO synth_agents")) return { rows: [{ id: values[0] } as Row] };
      return { rows: [{ resource_id: values[0], owner_id: values[1], fencing_token: values[2], acquired_at_ms: 1000, updated_at_ms: 2000, expires_at_ms: 7000 } as Row] };
    }
    if (sql.includes("INSERT INTO synth_agents")) return { rows: [{ id: values[0] } as Row] };
    throw new Error(`RecordingPg does not implement SQL: ${sql}`);
  }
}

test("Postgres lease acquire/renew/validation use the database clock, not worker time", async () => {
  const db = new RecordingPg();
  const store = new PostgresDistributedControlStore(db);
  const claim = await store.acquireLease("agent:a", "worker-a", 5_000, 123);
  assert.equal(claim.acquired, true);
  assert.equal(claim.lease.fencingToken, 7);
  const acquired = db.calls.at(-1)!;
  assert.match(acquired.text, /clock_timestamp\(\)/);
  assert.deepEqual(acquired.values, ["agent:a", "worker-a", 5_000]);
  assert.equal(acquired.values.includes(123), false);

  const renewed = await store.renewLease("agent:a", "worker-a", 7, 5_000, 456);
  assert.equal(renewed?.expiresAt, 7000);
  const renewal = db.calls.at(-1)!;
  assert.match(renewal.text, /clock_timestamp\(\)/);
  assert.deepEqual(renewal.values, ["agent:a", "worker-a", 7, 5_000]);
  assert.equal(renewal.values.includes(456), false);

  const valid = await store.validateLease("agent:a", "worker-a", 7, 789);
  assert.equal(valid?.fencingToken, 7);
  const validation = db.calls.at(-1)!;
  assert.match(validation.text, /clock_timestamp\(\)/);
  assert.deepEqual(validation.values, ["agent:a", "worker-a", 7]);
  assert.equal(validation.values.includes(789), false);
});

test("Postgres hard-fenced agent write atomically validates owner, token and DB-time expiry", async () => {
  const db = new RecordingPg();
  const store = new PostgresPersistence(db);
  const snapshot: AgentSnapshot = {
    id: "agent-a" as any,
    definitionId: "d",
    workspaceId: "workspace-a" as any,
    state: "thinking",
    createdAt: 1,
    updatedAt: 2,
    mailbox: [],
    metadata: {},
  };

  assert.equal(await store.putAgentFenced(snapshot, fence(snapshot.id, "worker-a", 9)), true);
  const fenced = db.calls.at(-1)!;
  assert.match(fenced.text, /clock_timestamp\(\)/);
  assert.match(fenced.text, /synth_leases\.owner_id=\$4/);
  assert.match(fenced.text, /synth_leases\.fencing_token=\$5/);
  assert.match(fenced.text, /synth_leases\.expires_at_ms>db_clock\.now_ms/);
  assert.deepEqual(fenced.values.slice(2), [`agent:${snapshot.id}`, "worker-a", 9]);

  await store.putAgent({ ...snapshot, state: "idle" });
  const bootstrap = db.calls.at(-1)!;
  assert.match(bootstrap.text, /WHERE synth_agents\.fencing_token=0/);
});
