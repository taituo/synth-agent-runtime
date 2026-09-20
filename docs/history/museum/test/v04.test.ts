import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  DurableTurn,
  ExecutionBroker,
  JsonFileRuntimeStateStore,
  LocalMemoryDurability,
  LocalRuntimeStateStore,
  MemoryWorkspace,
  ProfileRouterBackend,
  SyntheticExecutor,
  runDurableTransactionalTurn,
  type AgentEngine,
  type Effect,
  type Executor,
  type GatewayBackend,
} from "../src/index.js";

test("durable turn hides failed-attempt output and restores workspace", async () => {
  const workspace = new MemoryWorkspace();
  workspace.write("a.txt", "base");
  const published: string[] = [];
  const store = new LocalRuntimeStateStore();
  const result = await runDurableTransactionalTurn({
    workspace,
    store,
    publishOutput: (text) => { published.push(text); },
    attempts: [
      {
        id: "provider-a",
        retryable: () => true,
        async run(turn) {
          workspace.write("a.txt", "bad");
          turn.emitOutput("must-never-escape");
          throw new Error("429");
        },
      },
      {
        id: "provider-b",
        retryable: () => false,
        async run(turn) {
          assert.equal(await workspace.readText("a.txt"), "base");
          workspace.write("a.txt", "good");
          turn.emitOutput("committed");
          return 42;
        },
      },
    ],
  });
  assert.equal(result, 42);
  assert.deepEqual(published, ["committed"]);
  assert.equal(await workspace.readText("a.txt"), "good");
  const rolled = await store.listTurns("rolled_back");
  const committed = await store.listTurns("committed");
  assert.equal(rolled.length, 1);
  assert.equal(committed.length, 1);
});

test("barrier effect prevents transparent retry", async () => {
  const workspace = new MemoryWorkspace();
  const store = new LocalRuntimeStateStore();
  let approvals = 0;
  await assert.rejects(
    runDurableTransactionalTurn({
      workspace,
      store,
      executeEffect: async () => { approvals++; return { ok: true, output: "yes" }; },
      attempts: [
        {
          id: "a",
          retryable: () => true,
          async run(turn) {
            await turn.executeEffect({ id: "approval-1", kind: "human.approval", prompt: "ship?" });
            throw new Error("stream dropped");
          },
        },
        {
          id: "b",
          retryable: () => false,
          async run() { return 1; },
        },
      ],
    }),
    /stream dropped/,
  );
  assert.equal(approvals, 1);
});

test("execution broker uses effect id as durable idempotency key", async () => {
  const state = new LocalRuntimeStateStore();
  let calls = 0;
  const executor: Executor = {
    id: "x",
    fidelity: 1,
    canExecute: () => true,
    async execute() { calls++; return { ok: true, output: { calls } }; },
  };
  const broker = new ExecutionBroker([executor], state);
  const effect: Effect = { id: "stable-effect", kind: "process.exec", command: "true" };
  const context = { agentId: "a" as any, workspaceId: "w" as any };
  const first = await broker.execute(effect, context);
  const second = await broker.execute(effect, context);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
});

test("runtime recovers agent + workspace checkpoint after restart", async () => {
  const durability = new LocalMemoryDurability();
  const state = new LocalRuntimeStateStore();
  const runtime1 = new AgentRuntime(durability, undefined, new Map(), state);
  const workspace = await runtime1.createWorkspace(new MemoryWorkspace());
  workspace.write("survives.txt", "yes");
  const definition = { id: "worker", inferenceProfile: { id: "worker" } };
  const engine: AgentEngine = { async run() { return "ok"; } };
  const agent = await runtime1.spawn({ definition, engine, workspace });
  await runtime1.checkpointWorkspace(workspace.id, "test");

  const runtime2 = new AgentRuntime(durability, undefined, new Map(), state);
  const recovered = await runtime2.recover({ definition: () => definition, engine: () => engine });
  assert.equal(recovered.agents, 1);
  assert.equal(runtime2.get(agent.id).state, "idle");
  assert.equal(await runtime2.workspaces.get(workspace.id)?.readText("survives.txt"), "yes");
});

test("json runtime state survives process-style reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synth-runtime-"));
  try {
    const path = join(dir, "runtime.json");
    const first = new JsonFileRuntimeStateStore(path);
    await first.putCommand({ id: "c", status: "committed", startedAt: 1, updatedAt: 2, result: { ok: true } });
    const second = new JsonFileRuntimeStateStore(path);
    assert.deepEqual((await second.getCommand("c"))?.result, { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway keeps session affinity after fallback", async () => {
  const seen: string[] = [];
  let firstCalls = 0;
  const backend = (name: string, fn: () => number): GatewayBackend => ({
    async listModels() { return []; },
    async handle() { seen.push(name); return new Response("{}", { status: fn() }); },
  });
  const router = new ProfileRouterBackend({
    backends: {
      first: backend("first", () => (++firstCalls === 1 ? 429 : 200)),
      second: backend("second", () => 200),
    },
    profiles: [{ model: { id: "worker" }, routes: [
      { id: "r1", backend: "first" },
      { id: "r2", backend: "second" },
    ] }],
  });
  const request = () => new Request("http://router/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-synth-session": "s1" },
    body: JSON.stringify({ model: "worker", input: "x" }),
  });
  assert.equal((await router.handle(request(), "worker")).status, 200);
  assert.equal((await router.handle(request(), "worker")).status, 200);
  assert.deepEqual(seen, ["first", "second", "second"]);
});


test("recover rolls back a turn left started by a crashed process", async () => {
  const durability = new LocalMemoryDurability();
  const state = new LocalRuntimeStateStore();
  const runtime1 = new AgentRuntime(durability, undefined, new Map(), state);
  const workspace = await runtime1.createWorkspace(new MemoryWorkspace());
  workspace.write("a.txt", "before");
  const definition = { id: "worker", inferenceProfile: { id: "worker" } };
  const engine: AgentEngine = { async run() { return "ok"; } };
  await runtime1.spawn({ definition, engine, workspace });

  await DurableTurn.begin({ workspace, store: state, attemptId: "a" });
  workspace.write("a.txt", "half-finished");

  const runtime2 = new AgentRuntime(durability, undefined, new Map([[workspace.id, workspace]]), state);
  const result = await runtime2.recover({ definition: () => definition, engine: () => engine });
  assert.equal(result.incompleteTurnsRolledBack, 1);
  assert.equal(await workspace.readText("a.txt"), "before");
  assert.equal((await state.listTurns("started")).length, 0);
  assert.equal((await state.listTurns("rolled_back")).length, 1);
});

test("attempt-local effect receipts are scoped per durable retry attempt", async () => {
  const workspace = new MemoryWorkspace();
  const workspaces = new Map([[workspace.id, workspace]]);
  const state = new LocalRuntimeStateStore();
  const broker = new ExecutionBroker([new SyntheticExecutor(workspaces)], state);
  const context = { agentId: "agent-retry" as any, workspaceId: workspace.id };
  let attempts = 0;

  const result = await runDurableTransactionalTurn({
    workspace,
    store: state,
    executeEffect: (effect) => broker.execute(effect, context),
    attempts: [
      {
        id: "first",
        async run(turn) {
          attempts++;
          await turn.executeEffect({ id: "write-file", kind: "workspace.write", path: "x.txt", content: "first" });
          assert.equal(await workspace.readText("x.txt"), "first");
          throw new Error("retry me");
        },
        retryable: () => true,
      },
      {
        id: "second",
        async run(turn) {
          attempts++;
          await turn.executeEffect({ id: "write-file", kind: "workspace.write", path: "x.txt", content: "second" });
          return await workspace.readText("x.txt");
        },
        retryable: () => false,
      },
    ],
  });

  assert.equal(attempts, 2);
  assert.equal(result, "second");
  assert.equal(await workspace.readText("x.txt"), "second");
});

test("recovery does not label a semantically exposed turn as transparently rolled back", async () => {
  const durability = new LocalMemoryDurability();
  const state = new LocalRuntimeStateStore();
  const runtime1 = new AgentRuntime(durability, undefined, new Map(), state);
  const workspace = await runtime1.createWorkspace(new MemoryWorkspace());
  workspace.write("a.txt", "before");
  const definition = { id: "worker", inferenceProfile: { id: "worker" } };
  const engine: AgentEngine = { async run() { return "ok"; } };
  await runtime1.spawn({ definition, engine, workspace });

  const turn = await DurableTurn.begin({
    workspace,
    store: state,
    attemptId: "barrier-attempt",
    executeEffect: async () => ({ ok: true, output: "approved" }),
  });
  await turn.executeEffect({ id: "approval", kind: "human.approval", prompt: "approve" });
  workspace.write("a.txt", "after-boundary");

  const runtime2 = new AgentRuntime(durability, undefined, new Map([[workspace.id, workspace]]), state);
  const result = await runtime2.recover({ definition: () => definition, engine: () => engine });
  assert.equal(result.incompleteTurnsRolledBack, 0);
  assert.equal(result.incompleteTurnsFailed, 1);
  assert.equal(await workspace.readText("a.txt"), "before");
  const failed = await state.listTurns("failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.semanticExposed, true);
  assert.match(failed[0]?.error ?? "", /reconciliation required/i);
});


test("durable turn serializes async metadata writes before terminal commit", async () => {
  class DelayedStore extends LocalRuntimeStateStore {
    override async putTurn(record: Parameters<LocalRuntimeStateStore["putTurn"]>[0]): Promise<void> {
      if (record.status === "started" && record.bufferedOutputCount === 1 && !record.semanticExposed) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await super.putTurn(record);
    }
  }

  const workspace = new MemoryWorkspace();
  const store = new DelayedStore();
  const turn = await DurableTurn.begin({ workspace, store, attemptId: "ordered" });
  turn.emitOutput("visible-at-commit");
  await turn.commit();

  const record = await store.getTurn(turn.id);
  assert.equal(record?.status, "committed");
  assert.equal(record?.semanticExposed, true);
});

test("durable turn persists semantic exposure before publishing buffered output", async () => {
  const workspace = new MemoryWorkspace();
  const store = new LocalRuntimeStateStore();
  let observedExposure = false;
  const turn = await DurableTurn.begin({
    workspace,
    store,
    attemptId: "publish-boundary",
    publishOutput: async () => {
      const record = await store.getTurn(turn.id);
      observedExposure = record?.status === "started" && record.semanticExposed === true;
    },
  });
  turn.emitOutput("hello");
  await turn.commit();

  assert.equal(observedExposure, true);
  assert.equal((await store.getTurn(turn.id))?.status, "committed");
});

test("logical command exceptions fail closed unless explicitly retry-safe", async () => {
  const durability = new LocalMemoryDurability();
  const state = new LocalRuntimeStateStore();
  const runtime = new AgentRuntime(durability, undefined, new Map(), state);
  let uncertainCalls = 0;

  await assert.rejects(runtime.command("uncertain-command", async () => {
    uncertainCalls++;
    throw new Error("transport dropped after boundary");
  }), /transport dropped/);
  await assert.rejects(runtime.command("uncertain-command", async () => {
    uncertainCalls++;
    return "duplicate";
  }), /COMMAND_OUTCOME_UNCERTAIN/);
  assert.equal(uncertainCalls, 1);

  let safeCalls = 0;
  await assert.rejects(runtime.command("retry-safe-command", async () => {
    safeCalls++;
    throw new Error("pure validation failure");
  }, { retrySafeOnError: true }), /validation failure/);
  const result = await runtime.command("retry-safe-command", async () => {
    safeCalls++;
    return "retried";
  }, { retrySafeOnError: true });
  assert.equal(result, "retried");
  assert.equal(safeCalls, 2);
});
