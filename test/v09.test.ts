import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentRuntime,
  InMemoryLeaseStore,
  LeasedAgentRunner,
  LocalMemoryDurability,
  MemoryWorkspace,
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

test("hard agent fencing rejects a stale terminal write after takeover", async () => {
  const durability = new LocalMemoryDurability();
  const runtime = new AgentRuntime(durability);
  const workspace = await runtime.createWorkspace(new MemoryWorkspace());

  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });

  const agent = await runtime.spawn({
    definition: { id: "fenced", inferenceProfile: { id: "test" } },
    workspace,
    engine: {
      async run() {
        signalStarted();
        await wait;
        return "stale-result";
      },
    },
  });

  const staleRun = runtime.run(agent.id, { fence: fence(agent.id, "worker-a", 1) });
  await started;
  assert.equal((await durability.getAgent(agent.id))?.state, "thinking");

  const winner = (await durability.getAgent(agent.id))!;
  winner.state = "waiting_for_agent";
  winner.updatedAt += 1;
  assert.equal(await durability.putAgentFenced!(winner, fence(agent.id, "worker-b", 2)), true);

  finish();
  await assert.rejects(staleRun, /AGENT_FENCE_REJECTED/);
  assert.equal((await durability.getAgent(agent.id))?.state, "waiting_for_agent");

  const events = await durability.listEvents();
  assert.equal(events.some((event) => event.type === "agent.completed"), false);
  assert.equal(events.some((event) => event.type === "agent.failed"), false);
});

test("leased agent runner supplies the lease generation to durable state writes", async () => {
  const durability = new LocalMemoryDurability();
  const runtime = new AgentRuntime(durability);
  const workspace = await runtime.createWorkspace(new MemoryWorkspace());
  const agent = await runtime.spawn({
    definition: { id: "runner", inferenceProfile: { id: "test" } },
    workspace,
    engine: { async run() { return "ok"; } },
  });
  const runner = new LeasedAgentRunner(runtime, new InMemoryLeaseStore(), "worker-a", 1_000);
  assert.equal(await runner.run(agent.id), "ok");
  assert.equal((await durability.getAgent(agent.id))?.state, "completed");
});

interface QueryCall { text: string; values: unknown[] }
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
